import { NextRequest, NextResponse } from 'next/server';
import { getTwitterClient } from '@/lib/twitter';
import { getSupabaseAdmin } from '@/lib/supabase';

// Final deployment trigger
export const dynamic = 'force-dynamic';

// Constants
const STEAM_FEATURED_API = 'https://store.steampowered.com/api/featuredcategories/?cc=tr';
const CURRENCY_API_URL = 'https://open.er-api.com/v6/latest/USD';

async function getUsdToTryRate(): Promise<number> {
    try {
        const res = await fetch(CURRENCY_API_URL);
        const data = await res.json();
        return data.rates.TRY || 42.73; // Fallback to current rate if API fails
    } catch (error) {
        console.error('Failed to fetch exchange rate:', error);
        return 42.73; // Fallback
    }
}

export async function GET(request: NextRequest) {
    try {
        // 1. Security Check
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const twitterClient = getTwitterClient();
        const supabaseAdmin = getSupabaseAdmin();

        // 2. Fetch Featured/Specials from Steam
        console.log('Fetching from Steam Featured API...');
        const featuredRes = await fetch(STEAM_FEATURED_API, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!featuredRes.ok) {
            throw new Error(`Steam Featured API returned ${featuredRes.status}`);
        }

        const featuredData = await featuredRes.json();

        // 3. Combine items from different categories for a wider pool
        const rawItems: any[] = [
            ...(featuredData.specials?.items || []),
            ...(featuredData.top_sellers?.items || []),
            ...(featuredData.daily_deals?.items || [])
        ];

        // De-duplicate by app_id
        const uniqueItemsMap = new Map();
        for (const item of rawItems) {
            if (!uniqueItemsMap.has(item.id)) {
                uniqueItemsMap.set(item.id, item);
            }
        }
        const uniqueItems = Array.from(uniqueItemsMap.values());
        console.log(`Found ${uniqueItems.length} unique items across categories.`);

        // 4. PRE-SORT by discount percentage to prioritize high deals
        const sortedUniqueItems = uniqueItems.sort((a, b) => b.discount_percent - a.discount_percent);

        // 5. Filtering and Verification
        const candidates = [];
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        console.log(`Checking top ${Math.min(sortedUniqueItems.length, 20)} candidates for reviews and duplicates...`);

        // Limit the pool to the top 20 discount holders to avoid timeouts
        for (const item of sortedUniqueItems.slice(0, 20)) {
            // Basic Filter
            if (item.discount_percent < 30) continue;

            // CHECK DUPLICATE FIRST (Cheaper than fetching reviews)
            const { data: existingPosts, error: dbError } = await supabaseAdmin
                .from('posted_games')
                .select('id')
                .eq('app_id', parseInt(item.id))
                .gt('created_at', fortyEightHoursAgo);

            if (dbError) {
                console.error(`Supabase DB Error for ${item.name}:`, dbError);
                continue;
            }

            if (existingPosts && existingPosts.length > 0) {
                console.log(`SKIP: ${item.name} was already posted recently.`);
                continue;
            }

            // Fetch Reviews only if it's NOT a duplicate
            console.log(`Checking reviews for ${item.name} (${item.id})...`);
            const reviewRes = await fetch(`https://store.steampowered.com/appreviews/${item.id}?json=1&language=all&purchase_type=all`);
            if (!reviewRes.ok) continue;

            const reviewData = await reviewRes.json();
            const reviewDesc = reviewData.query_summary?.review_score_desc;

            const isHighlyRated =
                reviewDesc === 'Very Positive' ||
                reviewDesc === 'Overwhelmingly Positive';

            if (isHighlyRated) {
                candidates.push({
                    ...item,
                    review_desc: reviewDesc
                });

                // We only need one game to post, so we can stop as soon as we find a valid candidate
                // but we keep going just to log a few more options
                if (candidates.length >= 3) break;
            }
        }

        if (candidates.length === 0) {
            console.log('No new games passed the filters in the top pool.');
            return NextResponse.json({ message: 'No new eligible games found (checked top 20 discounts).' });
        }

        // 6. Select the top candidate (already sorted by discount)
        const topGame = candidates[0];
        console.log(`MATCH: ${topGame.name} is selected!`);

        // 7. Media Handling
        const imageResponse = await fetch(topGame.header_image); // featuredcategories has header_image
        if (!imageResponse.ok) {
            throw new Error('Failed to download game image');
        }
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // Upload Media to Twitter
        const mediaId = await twitterClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });

        // 6. Format Tweet
        // Steam returns price in cents (e.g., 599 for $5.99)
        const priceUSD = topGame.final_price / 100;
        const usdToTryRate = await getUsdToTryRate();
        const priceTRY = (priceUSD * usdToTryRate).toFixed(2);

        const tweetText = `🔥 ${topGame.name}

📉 %${topGame.discount_percent} İndirim
🏷️ ${priceTRY} ₺ (Yaklaşık)

https://store.steampowered.com/app/${topGame.id}`;

        // 7. Post Tweet
        await twitterClient.v2.tweet({
            text: tweetText,
            media: { media_ids: [mediaId] }
        });

        // 8. Log to Supabase
        const appIdInt = parseInt(topGame.id.toString());
        console.log(`Final step: Logging to Supabase with app_id: ${appIdInt}`);

        const { data: insertData, error: insertError } = await supabaseAdmin
            .from('posted_games')
            .insert({
                app_id: appIdInt,
                game_title: topGame.name,
                price_usd: priceUSD
            })
            .select();

        if (insertError) {
            console.error('CRITICAL: Supabase insertion failed!', insertError);
        } else {
            console.log('SUCCESS: Game successfully logged to Supabase.', insertData);
        }

        return NextResponse.json({
            success: true,
            message: `Successfully posted ${topGame.name}`,
            gameId: topGame.id,
            rating: topGame.review_desc
        });

    } catch (error: any) {
        console.error('Cron job failed:', error);
        return NextResponse.json({
            error: 'Internal Server Error',
            details: error.message
        }, { status: 500 });
    }
}

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

        // 3. ROBUST RETRIEVAL: Scan ALL categories in the response
        const rawItems: any[] = [];
        for (const key in featuredData) {
            if (featuredData[key]?.items && Array.isArray(featuredData[key].items)) {
                console.log(`Scanned category '${key}': Found ${featuredData[key].items.length} items.`);
                rawItems.push(...featuredData[key].items);
            }
        }

        // De-duplicate by app_id
        const uniqueItemsMap = new Map();
        for (const item of rawItems) {
            if (!uniqueItemsMap.has(item.id)) {
                uniqueItemsMap.set(item.id, item);
            }
        }
        const uniqueItems = Array.from(uniqueItemsMap.values());
        console.log(`Total unique items found across ALL categories: ${uniqueItems.length}`);

        // 4. PRE-SORT by discount percentage
        const sortedUniqueItems = uniqueItems.sort((a, b) => b.discount_percent - a.discount_percent);

        // 5. Deep Filtering with Diagnostic Logs
        const candidates = [];
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        // Check top 30 items to be thorough
        for (const item of sortedUniqueItems.slice(0, 30)) {
            // Filter 1: Discount
            if (item.discount_percent < 30) {
                console.log(`REJECT: ${item.name} (${item.id}) - Discount too low (${item.discount_percent}%)`);
                continue;
            }

            // Filter 2: Duplicate Check
            const { data: existingPosts, error: dbError } = await supabaseAdmin
                .from('posted_games')
                .select('id')
                .eq('app_id', parseInt(item.id))
                .gt('created_at', fortyEightHoursAgo);

            if (dbError) {
                console.error(`DB Error while checking ${item.name}:`, dbError);
                continue;
            }

            if (existingPosts && existingPosts.length > 0) {
                console.log(`REJECT: ${item.name} (${item.id}) - Already posted in last 48h.`);
                continue;
            }

            // Filter 3: Reviews
            console.log(`Evaluating: ${item.name} (${item.id}) - Fetching reviews...`);
            const reviewRes = await fetch(`https://store.steampowered.com/appreviews/${item.id}?json=1&language=all&purchase_type=all`);
            if (!reviewRes.ok) {
                console.log(`REJECT: ${item.name} (${item.id}) - Review fetch failed (${reviewRes.status})`);
                continue;
            }

            const reviewData = await reviewRes.json();
            const reviewDesc = reviewData.query_summary?.review_score_desc;

            const isHighlyRated =
                reviewDesc === 'Very Positive' ||
                reviewDesc === 'Overwhelmingly Positive';

            if (!isHighlyRated) {
                console.log(`REJECT: ${item.name} (${item.id}) - Rating not good enough: ${reviewDesc}`);
                continue;
            }

            console.log(`MATCH: ${item.name} passed all filters!`);
            candidates.push({
                ...item,
                review_desc: reviewDesc
            });

            if (candidates.length >= 3) break;
        }

        if (candidates.length === 0) {
            console.log('DIAGNOSTIC: No games found in the top 30 pool that passed all filters.');
            return NextResponse.json({ message: 'No new eligible games found in the top 30 discounts.' });
        }

        // 6. Select the top candidate (already sorted by discount)
        const topGame = candidates[0];
        console.log(`MATCH: ${topGame.name} is selected!`);

        // 7. Media & Posting with Specific Error Capture
        console.log(`Starting media preparation for ${topGame.name}...`);
        const imageResponse = await fetch(topGame.header_image);
        if (!imageResponse.ok) {
            throw new Error(`Media fetch failed for ${topGame.name}: ${imageResponse.status}`);
        }
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        let mediaId;
        try {
            mediaId = await twitterClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });
            console.log(`Twitter Media uploaded: ${mediaId}`);
        } catch (twitterMediaError: any) {
            console.error('CRITICAL: Twitter Media Upload Failed!', twitterMediaError.message);
            throw twitterMediaError;
        }

        // 6. Format Tweet
        // Steam returns price in cents (e.g., 599 for $5.99)
        const priceUSD = topGame.final_price / 100;
        const usdToTryRate = await getUsdToTryRate();
        const priceTRY = (priceUSD * usdToTryRate).toFixed(2);

        const tweetText = `🔥 ${topGame.name}\n\n📉 %${topGame.discount_percent} İndirim\n🏷️ ${priceTRY} ₺ (Yaklaşık)\n\nhttps://store.steampowered.com/app/${topGame.id}`;

        try {
            await twitterClient.v2.tweet({
                text: tweetText,
                media: { media_ids: [mediaId] }
            });
            console.log(`SUCCESS: Tweet posted for ${topGame.name}`);
        } catch (twitterTweetError: any) {
            console.error('CRITICAL: Twitter Post Failed!', twitterTweetError.message);
            throw twitterTweetError;
        }

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

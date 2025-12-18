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
        const specials = featuredData.specials?.items || [];

        // 3. Filtering and Verification
        const candidates = [];

        for (const item of specials) {
            // Basic Filters
            const isHighDiscount = item.discount_percent >= 30;
            // Note: we can't be 100% sure about "game" type from this endpoint alone, 
            // but usually these are the main titles. We'll check reviews now.

            if (!isHighDiscount) continue;

            // Fetch Reviews for this specific game
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
            }

            // Stop after finding a few candidates to avoid rate limits
            if (candidates.length >= 5) break;
        }

        if (candidates.length === 0) {
            return NextResponse.json({ message: 'No games passed the filters today.' });
        }

        // 4. Find the best game that hasn't been posted yet
        const sortedCandidates = candidates.sort((a, b) => b.discount_percent - a.discount_percent);
        let topGame = null;

        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        console.log(`Current Time (ISO): ${new Date().toISOString()}`);
        console.log(`Checking duplicates since: ${fortyEightHoursAgo}`);

        for (const game of sortedCandidates) {
            console.log(`Checking: ${game.name} (app_id: ${game.id})`);

            // Check for any post in the last 48 hours
            const { data: existingPosts, error: dbError } = await supabaseAdmin
                .from('posted_games')
                .select('id, created_at')
                .eq('app_id', parseInt(game.id))
                .gt('created_at', fortyEightHoursAgo);

            if (dbError) {
                console.error(`Supabase DB Error for ${game.name}:`, dbError);
                continue; // Skip this game if we can't verify its status
            }

            if (existingPosts && existingPosts.length > 0) {
                const lastPost = existingPosts[0];
                console.log(`SKIP: ${game.name} was already posted at ${lastPost.created_at}`);
                continue;
            }

            console.log(`MATCH: ${game.name} is new. Selecting!`);
            topGame = game;
            break;
        }

        if (!topGame) {
            console.log('No games to post. All candidates were duplicates.');
            return NextResponse.json({ message: 'No new eligible games found (checked top 5 candidates).' });
        }

        // 5. Media Handling
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
        console.log(`Logging ${topGame.name} to Supabase with app_id: ${topGame.id} and price_usd: ${priceUSD}`);
        const { error: insertError } = await supabaseAdmin
            .from('posted_games')
            .insert({
                app_id: parseInt(topGame.id),
                game_title: topGame.name,
                price_usd: priceUSD // Corrected: Use USD price instead of TRY
            });

        if (insertError) {
            console.error('Error logging to Supabase:', insertError);
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

import { NextRequest, NextResponse } from 'next/server';
import { getTwitterClient } from '@/lib/twitter';
import { getSupabaseAdmin } from '@/lib/supabase';

// Final deployment trigger
export const dynamic = 'force-dynamic';

// Constants
const ITAD_API_KEY = process.env.ITAD_API_KEY || 'b0a1c3354549db7f5371f9b05de11261634a0aa4';
const ITAD_DEALS_API = `https://api.isthereanydeal.com/deals/v2?key=${ITAD_API_KEY}&country=TR&limit=100`;

export async function GET(request: NextRequest) {
    try {
        // 1. Security Check
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const twitterClient = getTwitterClient();
        const supabaseAdmin = getSupabaseAdmin();

        // 2. Fetch Data from ITAD Deals API
        console.log('Fetching from ITAD API...');
        const itadRes = await fetch(ITAD_DEALS_API, { headers: { 'User-Agent': 'Mozilla/5.0' } });

        if (!itadRes.ok) {
            throw new Error(`ITAD API fetch failed: ${itadRes.status}`);
        }

        const itadData = await itadRes.json();
        const dealList = itadData.list || [];
        console.log(`ITAD returned ${dealList.length} deals.`);

        // 3. Process and Score Items
        // We'll map ITAD deals to our standard format.
        // ITAD typically returns results sorted by relevance/popularity, but we'll apply our own logic.
        const rawItems = dealList.map((item: any, index: number) => {
            return {
                itad_id: item.id,
                name: item.title,
                type: item.type, // game, dlc, package
                discount_percent: item.deal.cut,
                final_price: item.deal.price.amount, // This is already in TRY float
                currency: item.deal.price.currency,
                shop_name: item.deal.shop.name,
                shop_id: item.deal.shop.id,
                deal_url: item.deal.url,
                search_rank: index + 1, // Use position in ITAD list as proxy for popularity
                header_image: item.assets.banner600 || item.assets.banner400 || item.assets.banner300 || `https://assets.isthereanydeal.com/placeholder.jpg`
            };
        });

        // 4. SCORING & SORTING (Prioritize High Discount + Popularity)
        const scoredUniqueItems = rawItems.map((item: any) => {
            const popularityBonus = Math.max(0, 100 - item.search_rank);
            // Extra bonus for 100% discount (Free games)
            const freeBonus = item.discount_percent === 100 ? 500 : 0;
            // Bonus for standalone games vs DLC/Packages
            const typeBonus = item.type === 'game' ? 50 : 0;

            return {
                ...item,
                selection_score: item.discount_percent + (popularityBonus * 1.5) + freeBonus + typeBonus
            };
        }).sort((a: any, b: any) => b.selection_score - a.selection_score);

        // 5. Deep Filtering
        const candidates = [];
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        console.log('--- [v4-ITAD] SCANNING CANDIDATES ---');
        for (const item of scoredUniqueItems.slice(0, 100)) {
            // Filter 1: Discount and Junk Titles
            if (item.discount_percent < 25) {
                console.log(`SKIP: ${item.name} - Discount too low (${item.discount_percent}%)`);
                continue;
            }

            if (item.name.toLowerCase().includes('commercial license') ||
                item.name.toLowerCase().includes('soundtrack') ||
                item.name.toLowerCase().includes('subscription')) {
                if (item.discount_percent < 95) { // Only allow these if they are near-free or free
                    console.log(`SKIP: ${item.name} - Non-game or license title with sub-95% discount.`);
                    continue;
                }
            }

            // Filter 2: Fetch Info to get AppID and Reviews
            console.log(`Fetching ITAD Info for: ${item.name} (${item.itad_id})...`);
            const infoRes = await fetch(`https://api.isthereanydeal.com/games/info/v2?key=${ITAD_API_KEY}&id=${item.itad_id}`);
            if (!infoRes.ok) {
                console.log(`SKIP: ${item.name} - Info fetch failed.`);
                continue;
            }
            const infoData = await infoRes.json();
            const appId = infoData.appid; // numeric or null

            // Filter 3: Duplicate Check
            if (appId) {
                const { data: existingPosts, error: dbError } = await supabaseAdmin
                    .from('posted_games')
                    .select('id, created_at')
                    .eq('app_id', appId)
                    .gt('created_at', fortyEightHoursAgo);

                if (dbError) {
                    console.error(`DB Error while checking ${item.name}:`, dbError);
                    continue;
                }

                if (existingPosts && existingPosts.length > 0) {
                    console.log(`SKIP: ${item.name} (${appId}) - Already in DB (Posted at: ${existingPosts[0].created_at || 'unknown'})`);
                    continue;
                }
            }

            // Filter 4: Quality Check (using ITAD aggregated reviews if available)
            // If it has Steam reviews, we'll try to use those.
            const steamReview = infoData.reviews?.find((r: any) => r.source === 'Steam');
            let isGoodEnough = false;
            let reviewText = "No reviews";

            if (steamReview) {
                // ITAD gives a score (0-100) for Steam reviews based on positive %
                const score = steamReview.score || 0;
                isGoodEnough = score >= 70; // 70% positive is usually "Mostly Positive" or better
                reviewText = `Steam: %${score} Positive (${steamReview.count} reviews)`;
            } else if (infoData.reviews && infoData.reviews.length > 0) {
                // If no Steam reviews, check if any other source has a good score
                const avgScore = infoData.reviews.reduce((acc: number, r: any) => acc + (r.score || 0), 0) / infoData.reviews.length;
                isGoodEnough = avgScore >= 70;
                reviewText = `Avg Score: ${avgScore.toFixed(0)}`;
            } else if (appId) {
                // FALLBACK: If ITAD has no reviews but has an AppID, try Steam directly
                console.log(`  FALLBACK: Fetching Steam reviews for ${item.name} (${appId})...`);
                try {
                    const steamReviewRes = await fetch(`https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&l=english`);
                    if (steamReviewRes.ok) {
                        const steamReviewData = await steamReviewRes.json();
                        const totalPositive = steamReviewData?.query_summary?.total_positive || 0;
                        const totalNegative = steamReviewData?.query_summary?.total_negative || 0;
                        const totalReviews = steamReviewData?.query_summary?.total_reviews || 0;

                        if (totalReviews > 0) {
                            isGoodEnough = totalPositive > totalNegative;
                            const percent = ((totalPositive / totalReviews) * 100).toFixed(0);
                            reviewText = `Steam Fallback: %${percent} Positive (${totalReviews} reviews)`;
                        }
                    }
                } catch (e) {
                    console.error(`Steam fallback failed for ${item.name}:`, e);
                }
            }

            if (!isGoodEnough) {
                // RELAXATION: If it's a relatively popular item (top 30) with a decent discount, allow it
                if (item.search_rank <= 30 && item.discount_percent >= 50) {
                    console.log(`ALLOW (Popular): ${item.name} - Rank ${item.search_rank} exemption.`);
                    isGoodEnough = true;
                    reviewText = `Rank ${item.search_rank} Popularity`;
                } else {
                    console.log(`SKIP: ${item.name} - Rating not good enough or missing: ${reviewText} (Score: ${item.selection_score})`);
                    continue;
                }
            }

            // Skip known 403 placeholder
            if (item.header_image.includes('placeholder.jpg') && !appId) {
                console.log(`SKIP: ${item.name} - No AppID and only has placeholder image.`);
                continue;
            }

            // Use Steam CDN if appId is available for more reliable media fetch
            const finalHeaderImage = appId
                ? `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`
                : item.header_image;

            console.log(`MATCH: ${item.name} selected!`);
            candidates.push({
                ...item,
                steam_appid: appId,
                review_desc: reviewText,
                header_image: finalHeaderImage
            });

            if (candidates.length >= 10) break;
        }

        if (candidates.length === 0) {
            console.log('No games met the 25% discount and High Rating criteria in ITAD run.');
            return NextResponse.json({ message: 'No new eligible games found.' });
        }

        // 6. Media & Posting Loop (Try candidates until one succeeds)
        let postedSuccessful = false;
        let lastError = null;

        console.log(`Found ${candidates.length} candidates. Starting posting loop...`);
        for (const topGame of candidates) {
            console.log(`- Candidate: ${topGame.name} (${topGame.shop_name}) | URL: ${topGame.header_image}`);
        }

        for (const topGame of candidates) {
            try {
                console.log(`Starting media preparation for ${topGame.name} from ${topGame.shop_name}...`);
                const imageResponse = await fetch(topGame.header_image, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                });

                if (!imageResponse.ok) {
                    console.log(`Media fetch failed for ${topGame.name} (${imageResponse.status}). Trying next candidate...`);
                    continue;
                }

                const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

                let mediaId;
                try {
                    mediaId = await twitterClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });
                    console.log(`Twitter Media uploaded: ${mediaId}`);
                } catch (twitterMediaError: any) {
                    console.error(`Twitter Media Upload Failed for ${topGame.name}:`, twitterMediaError.message);
                    continue;
                }

                // 8. Format Tweet
                const priceTRY = topGame.final_price.toFixed(2);
                const shopEmoji = topGame.shop_name.toLowerCase().includes('epic') ? '🎮' :
                    topGame.shop_name.toLowerCase().includes('steam') ? '♨️' : '🏪';

                const tweetText = `🔥 ${topGame.name}\n\n📉 %${topGame.discount_percent} İndirim\n🏷️ ${priceTRY} ₺ (Yaklaşık)\n${shopEmoji} Mağaza: ${topGame.shop_name}\n\n${topGame.deal_url}`;

                try {
                    await twitterClient.v2.tweet({
                        text: tweetText,
                        media: { media_ids: [mediaId] }
                    });
                    console.log(`SUCCESS: Tweet posted for ${topGame.name}`);
                } catch (twitterTweetError: any) {
                    console.error(`Twitter Post Failed for ${topGame.name}:`, twitterTweetError.message);
                    continue;
                }

                // 9. Log to Supabase
                const dbAppId = topGame.steam_appid || 0;
                console.log(`Final step: Logging to Supabase with app_id: ${dbAppId}`);

                await supabaseAdmin
                    .from('posted_games')
                    .insert({
                        app_id: dbAppId,
                        game_title: topGame.name,
                        price_usd: 0
                    });

                postedSuccessful = true;
                return NextResponse.json({
                    success: true,
                    message: `Successfully posted ${topGame.name} from ${topGame.shop_name}`,
                    gameId: topGame.itad_id,
                    rating: topGame.review_desc
                });

            } catch (err: any) {
                console.error(`Failed to process candidate ${topGame.name}:`, err.message);
                lastError = err;
                continue;
            }
        }

        if (!postedSuccessful) {
            throw new Error(lastError?.message || 'All candidates failed during media/posting phase.');
        }

    } catch (error: any) {
        console.error('Cron job failed:', error);
        return NextResponse.json({
            error: 'Internal Server Error',
            details: error.message
        }, { status: 500 });
    }
}

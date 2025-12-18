import { NextRequest, NextResponse } from 'next/server';
import { getTwitterClient } from '@/lib/twitter';
import { getSupabaseAdmin } from '@/lib/supabase';

// Final deployment trigger
export const dynamic = 'force-dynamic';

// Constants
const STEAM_FEATURED_API = 'https://store.steampowered.com/api/featuredcategories/?cc=tr';
const STEAM_SEARCH_API = 'https://store.steampowered.com/search/results/?query&start=0&count=50&specials=1&infinite=1&json=1&cc=tr';
const CURRENCY_API_URL = 'https://open.er-api.com/v6/latest/USD';

async function getUsdToTryRate(): Promise<number> {
    try {
        const res = await fetch(CURRENCY_API_URL);
        const data = await res.json();
        return data.rates.TRY || 42.73; // Fallback
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

        // 2. Fetch Data from both Featured and Search APIs
        console.log('Fetching from Steam APIs...');
        const [featuredRes, searchRes] = await Promise.all([
            fetch(STEAM_FEATURED_API, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
            fetch(STEAM_SEARCH_API, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

        const rawItems: any[] = [];

        // 2a. Process Featured Data
        if (featuredRes.ok) {
            const featuredData = await featuredRes.json();
            for (const key in featuredData) {
                if (featuredData[key]?.items && Array.isArray(featuredData[key].items)) {
                    rawItems.push(...featuredData[key].items);
                }
            }
        }

        // 2b. Process Search Data (HTML Parsing)
        if (searchRes.ok) {
            const searchData = await searchRes.json();
            const html = searchData.results_html;

            if (!html) {
                console.log('Search API returned no results_html.');
            } else {
                const rows = html.split('</a>');
                console.log(`Search API HTML length: ${html.length}. Split into ${rows.length} potential rows.`);

                for (const row of rows) {
                    const idMatch = row.match(/data-ds-appid="(\d+)"/);
                    const nameMatch = row.match(/<span class="title">([^<]+)<\/span>/);
                    // Match discount (e.g., %50 or -50%)
                    const discMatch = row.match(/search_discount">[\s\S]*?<span>-?(\d+)%<\/span>/) ||
                        row.match(/search_discount">[\s\S]*?<span>%(\d+)<\/span>/);

                    // Match price. Steam sometimes shows 199,99 TL or 199.99 TL.
                    // We look for any numbers and commas/dots at the end of the search_price div
                    const priceMatch = row.match(/search_price[\s\S]*?<br>.*?([\d.,]+)/) ||
                        row.match(/search_price.*?>[\s\S]*?([\d.,]+)/);

                    if (idMatch && nameMatch) {
                        const appId = idMatch[1];
                        const name = nameMatch[1];
                        const discount = discMatch ? parseInt(discMatch[1]) : 0;

                        let finalPrice = 0;
                        if (priceMatch) {
                            // Convert "129,99" or "129.99" to cents integer
                            // Remove everything except digits. So 129,99 -> 12999
                            const cleanPrice = priceMatch[1].replace(/[^\d]/g, '');
                            finalPrice = parseInt(cleanPrice);
                        }

                        if (discount > 0) {
                            rawItems.push({
                                id: appId,
                                name: name,
                                discount_percent: discount,
                                final_price: finalPrice,
                                header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`
                            });
                        }
                    }
                }
            }
        }

        // 3. De-duplicate and Validate IDs
        const uniqueItemsMap = new Map();
        for (const item of rawItems) {
            // CRITICAL FIX: Ensure ID is present and is a number strings
            if (!item.id || isNaN(parseInt(item.id.toString()))) {
                console.log(`SKIP INVALID ID: ${item.name || 'Unknown'} (ID: ${item.id})`);
                continue;
            }
            if (!uniqueItemsMap.has(item.id)) {
                uniqueItemsMap.set(item.id, item);
            }
        }
        const uniqueItems = Array.from(uniqueItemsMap.values());
        console.log(`Total unique items found across ALL sources: ${uniqueItems.length}`);

        // 4. PRE-SORT by discount percentage
        const sortedUniqueItems = uniqueItems.sort((a, b) => b.discount_percent - a.discount_percent);

        // 5. Deep Filtering
        const candidates = [];
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

        console.log('--- SCANNING TOP 30 DISCOUNTS ---');
        for (const item of sortedUniqueItems.slice(0, 30)) {
            // Filter 1: Discount (Set to 25% for production variety)
            if (item.discount_percent < 25) {
                console.log(`SKIP: ${item.name} (${item.id}) - Discount too low (${item.discount_percent}%)`);
                continue;
            }

            // Filter 2: Duplicate Check
            const appIdInt = parseInt(item.id.toString());
            const { data: existingPosts, error: dbError } = await supabaseAdmin
                .from('posted_games')
                .select('id')
                .eq('app_id', appIdInt)
                .gt('created_at', fortyEightHoursAgo);

            if (dbError) {
                console.error(`DB Error while checking ${item.name}:`, dbError);
                continue;
            }

            if (existingPosts && existingPosts.length > 0) {
                console.log(`SKIP: ${item.name} (${item.id}) - Already posted recently.`);
                continue;
            }

            // Filter 3: Reviews
            console.log(`Evaluating: ${item.name} (${item.id}) - Discount: ${item.discount_percent}%. Fetching reviews...`);
            const reviewRes = await fetch(`https://store.steampowered.com/appreviews/${item.id}?json=1&language=all&purchase_type=all`);
            if (!reviewRes.ok) {
                console.log(`SKIP: ${item.name} (${item.id}) - Review fetch failed.`);
                continue;
            }

            const reviewData = await reviewRes.json();
            const reviewDesc = reviewData.query_summary?.review_score_desc;

            const isHighlyRated =
                reviewDesc === 'Very Positive' ||
                reviewDesc === 'Overwhelmingly Positive';

            if (!isHighlyRated) {
                console.log(`SKIP: ${item.name} (${item.id}) - Rating not good enough: "${reviewDesc}"`);
                continue;
            }

            console.log(`MATCH: ${item.name} selected!`);
            candidates.push({
                ...item,
                review_desc: reviewDesc
            });

            // We find up to 3 candidates but the first one (highest discount) will be posted
            if (candidates.length >= 3) break;
        }

        if (candidates.length === 0) {
            console.log('No games met the 25% discount and High Rating criteria in this run.');
            return NextResponse.json({ message: 'No new eligible games found.' });
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

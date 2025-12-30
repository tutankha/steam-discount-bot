import { NextRequest, NextResponse } from 'next/server';
import { getTwitterClient } from '@/lib/twitter';
import { getSupabaseAdmin } from '@/lib/supabase';

// CheapShark + Direct APIs - Fast (under 2 seconds)
export const dynamic = 'force-dynamic';

const MIN_METACRITIC = 60; // For CheapShark games
const MIN_GOG_REVIEWS = 500;

// Delay helper to avoid rate limiting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Max retry attempts for tweeting
const MAX_TWEET_ATTEMPTS = 3;

// Blacklist games that consistently fail (oversized images, duplicate issues)
const BLACKLISTED_GAMES = [
    'disco elysium',
    'wavetale',
    'skald'  // Posted twice due to name variations
];

// Fetch current USD/TRY exchange rate
async function getExchangeRate(): Promise<number> {
    try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        if (res.ok) {
            const data = await res.json();
            return data.rates?.TRY || 35;
        }
    } catch (e) {
        console.error('Exchange rate fetch failed:', e);
    }
    return 35; // Fallback rate
}

// ============ STEAM DEALS ============
async function fetchSteamDeals(): Promise<any[]> {
    const deals: any[] = [];
    const seen = new Set<number>();

    try {
        const res = await fetch('https://store.steampowered.com/api/featuredcategories?cc=tr', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            const allItems = [
                ...(data.specials?.items || []),
                ...(data.top_sellers?.items || []),
                ...(data.new_releases?.items || [])
            ];

            for (const item of allItems) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);

                if (item.discounted && item.discount_percent >= 25) {
                    deals.push({
                        id: item.id.toString(),
                        name: item.name,
                        discount_percent: item.discount_percent,
                        final_price: item.final_price / 100,
                        currency: 'USD', // Steam returns USD even with cc=tr
                        platform: 'Steam',
                        url: `https://store.steampowered.com/app/${item.id}`,
                        header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/header.jpg`
                    });
                }
            }
        }
    } catch (e) {
        console.error('Steam error:', e);
    }

    return deals;
}

// ============ EPIC DEALS (CheapShark + Free Games) ============
async function fetchEpicDeals(): Promise<any[]> {
    const deals: any[] = [];

    // Epic Free Games (direct API)
    try {
        const res = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=tr&country=TR', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            const games = data.data?.Catalog?.searchStore?.elements || [];

            for (const game of games) {
                if (!game.title || !game.promotions) continue;
                const promos = game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
                const isFree = promos.some((p: any) => p.discountSetting?.discountPercentage === 0);

                if (isFree) {
                    const slug = game.productSlug || game.urlSlug || game.catalogNs?.mappings?.[0]?.pageSlug;
                    if (slug && slug !== '[]') {
                        deals.push({
                            id: `epic_free_${game.id}`,
                            name: game.title,
                            discount_percent: 100,
                            final_price: 0,
                            currency: 'USD', // Free = 0, currency doesn't matter
                            platform: 'Epic Games',
                            metacritic: 90,
                            url: `https://store.epicgames.com/tr/p/${slug}`,
                            header_image: game.keyImages?.find((img: any) => img.type === 'OfferImageWide')?.url ||
                                game.keyImages?.[0]?.url
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error('Epic free games error:', e);
    }

    // CheapShark for Epic sales (fast, no API key, Metacritic filter)
    try {
        const res = await fetch(`https://www.cheapshark.com/api/1.0/deals?storeID=25&upperPrice=50&onSale=1&pageSize=20&metacritic=${MIN_METACRITIC}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();

            for (const game of data) {
                const discount = Math.round(parseFloat(game.savings) || 0);
                if (discount >= 50) {
                    const alreadyAdded = deals.some(d => d.name.toLowerCase() === game.title.toLowerCase());
                    if (!alreadyAdded) {
                        const steamAppId = game.steamAppID;

                        deals.push({
                            id: `epic_cs_${game.dealID}`,
                            name: game.title,
                            discount_percent: discount,
                            final_price: parseFloat(game.salePrice) || 0,
                            currency: 'USD',
                            platform: 'Epic Games',
                            metacritic: parseInt(game.metacriticScore) || 0,
                            url: `https://store.epicgames.com/tr/browse?q=${encodeURIComponent(game.title)}`,
                            header_image: steamAppId
                                ? `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`
                                : game.thumb
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error('CheapShark Epic error:', e);
    }

    return deals;
}

// ============ GOG DEALS ============
async function fetchGOGDeals(): Promise<any[]> {
    const deals: any[] = [];

    try {
        const res = await fetch('https://catalog.gog.com/v1/catalog?limit=20&order=desc:discount&productType=in:game', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            const products = data.products || [];

            for (const game of products) {
                const discountStr = game.price?.discount || '0';
                const discount = Math.abs(parseInt(discountStr.replace(/[^0-9-]/g, '')) || 0);
                const reviewsCount = game.reviewsCount || 0;

                if (discount >= 25 && reviewsCount >= MIN_GOG_REVIEWS) {
                    deals.push({
                        id: `gog_${game.id}`,
                        name: game.title,
                        discount_percent: discount,
                        final_price: parseFloat(game.price?.finalMoney?.amount) || 0,
                        currency: game.price?.finalMoney?.currency || 'USD',
                        platform: 'GOG',
                        url: game.storeLink || `https://www.gog.com/en/game/${game.slug}`,
                        header_image: game.coverHorizontal || null
                    });
                }
            }
        }
    } catch (e) {
        console.error('GOG error:', e);
    }

    return deals;
}

// ============ MAIN HANDLER ============
export async function GET(request: NextRequest) {
    const startTime = Date.now();
    const logs: string[] = [];
    const log = (msg: string) => {
        console.log(msg);
        logs.push(msg);
    };

    try {
        // 1. Security Check
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const twitterClient = getTwitterClient();
        const supabaseAdmin = getSupabaseAdmin();

        // 2. Fetch deals from all platforms (PARALLEL - Fast!)
        log('🔍 Fetching deals...');
        const [steamDeals, epicDeals, gogDeals] = await Promise.all([
            fetchSteamDeals(),
            fetchEpicDeals(),
            fetchGOGDeals()
        ]);

        const allDeals = [...steamDeals, ...epicDeals, ...gogDeals];
        log(`📦 Steam: ${steamDeals.length} | Epic: ${epicDeals.length} | GOG: ${gogDeals.length}`);

        // 3. Deduplicate: keep best deal per game (highest discount, then lowest price)
        // Normalize names by removing special characters for better matching
        const normalizeGameName = (name: string) =>
            name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

        const bestDeals = new Map<string, any>();
        for (const deal of allDeals) {
            const key = normalizeGameName(deal.name);
            const existing = bestDeals.get(key);

            if (!existing) {
                bestDeals.set(key, deal);
            } else {
                // Keep the one with higher discount, or if same, lower price
                const isBetterDiscount = deal.discount_percent > existing.discount_percent;
                const isSameDiscountLowerPrice = deal.discount_percent === existing.discount_percent
                    && deal.final_price < existing.final_price;

                if (isBetterDiscount || isSameDiscountLowerPrice) {
                    bestDeals.set(key, deal);
                }
            }
        }

        const uniqueDeals = Array.from(bestDeals.values())
            .sort((a, b) => b.discount_percent - a.discount_percent);

        log(`🎯 Total unique: ${uniqueDeals.length}`);

        // 4. Calculate repost window
        const poolSize = uniqueDeals.length;
        let repostHours = 48;
        if (poolSize >= 50) repostHours = 120;
        else if (poolSize >= 30) repostHours = 72;

        const repostWindow = new Date(Date.now() - repostHours * 60 * 60 * 1000).toISOString();
        log(`🕒 Repost window: last ${repostHours} hours (${repostWindow})`);

        // 5. Find first eligible game (with rate limit protection)
        let tweetAttempts = 0;

        for (const game of uniqueDeals) {
            // Stop if we've tried too many times (rate limit protection)
            if (tweetAttempts >= MAX_TWEET_ATTEMPTS) {
                log(`⚠️ STOPPING: Max tweet attempts (${MAX_TWEET_ATTEMPTS}) reached to avoid rate limiting`);
                break;
            }

            // Check if already posted (case-insensitive search)
            const normalizedTitle = normalizeGameName(game.name);
            const { data: existing, error: queryError } = await supabaseAdmin
                .from('posted_games')
                .select('id, game_title, created_at')
                .ilike('game_title', normalizedTitle)
                .gt('created_at', repostWindow);

            if (queryError) {
                log(`⚠️ DB query error: ${queryError.message}`);
            }

            if (existing && existing.length > 0) {
                log(`⏭️ Skip: ${game.name} (posted ${existing[0].created_at})`);
                continue;
            }

            if (!game.header_image) {
                continue; // Silent skip for no image
            }

            // Skip blacklisted games
            const isBlacklisted = BLACKLISTED_GAMES.some(bg => game.name.toLowerCase().includes(bg));
            if (isBlacklisted) {
                log(`⚫ Skipping blacklisted: ${game.name}`);
                continue;
            }

            log(`🎯 Trying: ${game.name} - ${game.discount_percent}% on ${game.platform}`);
            tweetAttempts++;

            // Add delay between tweet attempts (except first one)
            if (tweetAttempts > 1) {
                log(`⏳ Waiting 3 seconds before next attempt...`);
                await delay(3000);
            }

            // 6. Fetch image and post
            try {
                const imgRes = await fetch(game.header_image, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (!imgRes.ok) {
                    log(`⚠️ Image failed for ${game.name} (${imgRes.status})`);
                    continue;
                }

                const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                const mediaId = await twitterClient.v1.uploadMedia(imgBuffer, { mimeType: 'image/jpeg' });

                // 7. Format Tweet - Convert USD to TL using live rate
                const exchangeRate = await getExchangeRate();
                let priceInTL = game.final_price;
                let decimals = 2; // Default: 2 decimals for original TL prices
                if (game.currency === 'USD' && game.final_price > 0) {
                    priceInTL = game.final_price * exchangeRate;
                    decimals = 0; // Rounded for converted prices
                }
                const priceStr = game.final_price === 0 ? '🆓 ÜCRETSİZ' : `${priceInTL.toFixed(decimals)} ₺`;
                const platformEmoji = game.platform === 'Steam' ? '♨️' :
                    game.platform === 'Epic Games' ? '🎮' : '🌌';
                const metaStr = game.metacritic && game.metacritic > 0 ? `⭐ Metacritic: ${game.metacritic}\n` : '';

                const tweetText = `🔥 ${game.name}

📉 %${game.discount_percent} İndirim
🏷️ ${priceStr}
${platformEmoji} ${game.platform}
${metaStr}🔗 ${game.url}`.trim();

                // 8. Post Tweet
                await twitterClient.v2.tweet({ text: tweetText, media: { media_ids: [mediaId] } });

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                log(`✅ SUCCESS: Tweet posted for ${game.name} in ${elapsed}s`);

                // 9. Log to DB
                const numericAppId = parseInt(game.id.replace(/\D/g, '').slice(0, 9)) || 0;
                const normalizedTitleForDB = normalizeGameName(game.name);

                const { error: dbError } = await supabaseAdmin.from('posted_games').insert({
                    app_id: numericAppId,
                    game_title: normalizedTitleForDB,
                    price_usd: game.final_price || 0
                });

                if (dbError) {
                    log(`⚠️ DB insert error: ${dbError.message}`);
                } else {
                    log(`📝 Saved to DB: ${normalizedTitleForDB}`);
                }

                return NextResponse.json({
                    success: true,
                    game: game.name,
                    platform: game.platform,
                    discount: `${game.discount_percent}%`,
                    price: priceStr,
                    metacritic: game.metacritic || 'N/A',
                    elapsed: `${elapsed}s`,
                    logs
                });

            } catch (err: any) {
                const errorCode = err.code || err.data?.status || 'unknown';
                log(`❌ Failed: ${game.name} - ${err.message || errorCode}`);

                // Stop immediately on rate limit (429)
                if (err.code === 429 || err.message?.includes('429') || err.message?.includes('Too Many')) {
                    log(`🛑 RATE LIMITED! Stopping to avoid more 429 errors.`);
                    return NextResponse.json({
                        error: 'Rate limited by Twitter',
                        message: 'Try again after 15 minutes',
                        attempts: tweetAttempts,
                        logs
                    }, { status: 429 });
                }

                // For other errors, continue to next game
                continue;
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        log(`INFO: Finished scanning all ${uniqueDeals.length} unique deals. No new eligible games found.`);
        return NextResponse.json({ message: 'No new eligible games.', elapsed: `${elapsed}s`, logs });

    } catch (error: any) {
        log(`CRITICAL: Cron failed: ${error.message}`);
        return NextResponse.json({ error: error.message, logs: logs.length > 0 ? logs : undefined }, { status: 500 });
    }
}

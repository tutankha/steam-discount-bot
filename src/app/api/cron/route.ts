import { NextRequest, NextResponse } from 'next/server';
import { getTwitterClient } from '@/lib/twitter';
import { getSupabaseAdmin } from '@/lib/supabase';

// GitHub Actions ile çalışır - timeout sorunu yok
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 dakika (Vercel Pro için, Free'de 10s)

const ITAD_API_KEY = process.env.ITAD_API_KEY || 'b0a1c3354549db7f5371f9b05de11261634a0aa4';
const MIN_STEAM_REVIEWS = 1000;
const MIN_GOG_REVIEWS = 500;

// ============ HELPERS ============
async function getAppIdFromItad(itadId: string): Promise<string | null> {
    try {
        const res = await fetch(`https://api.isthereanydeal.com/games/info/v2?key=${ITAD_API_KEY}&id=${itadId}`);
        if (res.ok) {
            const data = await res.json();
            return data.appid?.toString() || null;
        }
    } catch (e) { }
    return null;
}

async function getSteamReviews(appId: string): Promise<{ count: number; percent: number } | null> {
    try {
        const res = await fetch(`https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all`);
        if (res.ok) {
            const data = await res.json();
            const positive = data.query_summary?.total_positive || 0;
            const total = data.query_summary?.total_reviews || 0;
            if (total > 0) {
                return { count: total, percent: Math.round((positive / total) * 100) };
            }
        }
    } catch (e) { }
    return null;
}

// ============ STEAM DEALS ============
async function fetchSteamDeals(): Promise<any[]> {
    const deals: any[] = [];
    const seen = new Set<number>();

    // Steam Featured API
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
                    const reviews = await getSteamReviews(item.id.toString());

                    deals.push({
                        id: item.id.toString(),
                        name: item.name,
                        discount_percent: item.discount_percent,
                        final_price: item.final_price / 100,
                        currency: 'TL',
                        platform: 'Steam',
                        review_percent: reviews?.percent || 0,
                        review_count: reviews?.count || 0,
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

// ============ EPIC DEALS ============
async function fetchEpicDeals(): Promise<any[]> {
    const deals: any[] = [];

    // Epic Free Games
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
                            id: `epic_${game.id}`,
                            name: game.title,
                            discount_percent: 100,
                            final_price: 0,
                            currency: 'TL',
                            platform: 'Epic Games',
                            review_percent: 90,
                            review_count: 10000,
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

    // ITAD for Epic sales (with popularity filter)
    try {
        const res = await fetch(`https://api.isthereanydeal.com/deals/v2?key=${ITAD_API_KEY}&country=TR&shops=16&limit=30&sort=-cut`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            const itadDeals = data.list || [];

            for (const item of itadDeals) {
                if (item.type === 'game' && item.deal.cut >= 50) { // Min %50 indirim
                    const alreadyAdded = deals.some(d => d.name.toLowerCase() === item.title.toLowerCase());
                    if (!alreadyAdded) {
                        const appId = await getAppIdFromItad(item.id);
                        if (!appId) continue;

                        const reviews = await getSteamReviews(appId);
                        if (!reviews || reviews.count < MIN_STEAM_REVIEWS) continue;

                        deals.push({
                            id: `epic_${item.id}`,
                            name: item.title,
                            discount_percent: item.deal.cut,
                            final_price: item.deal.price.amount,
                            currency: 'TL',
                            platform: 'Epic Games',
                            review_percent: reviews.percent,
                            review_count: reviews.count,
                            url: `https://store.epicgames.com/tr/p/${item.slug}`,
                            header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error('Epic ITAD error:', e);
    }

    return deals;
}

// ============ GOG DEALS ============
async function fetchGOGDeals(): Promise<any[]> {
    const deals: any[] = [];

    try {
        const res = await fetch('https://catalog.gog.com/v1/catalog?limit=30&order=desc:discount&productType=in:game', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
            const data = await res.json();
            const products = data.products || [];

            for (const game of products) {
                const discountStr = game.price?.discount || '0';
                const discount = Math.abs(parseInt(discountStr.replace(/[^0-9-]/g, '')) || 0);
                const reviewsCount = game.reviewsCount || 0;
                const reviewsRating = game.reviewsRating || 0;

                if (discount >= 25 && reviewsCount >= MIN_GOG_REVIEWS) {
                    deals.push({
                        id: `gog_${game.id}`,
                        name: game.title,
                        discount_percent: discount,
                        final_price: parseFloat(game.price?.finalMoney?.amount) || 0,
                        currency: game.price?.finalMoney?.currency || 'USD',
                        platform: 'GOG',
                        review_percent: Math.round((reviewsRating / 50) * 100),
                        review_count: reviewsCount,
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

    try {
        // 1. Security Check
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const twitterClient = getTwitterClient();
        const supabaseAdmin = getSupabaseAdmin();

        // 2. Fetch deals from all platforms
        console.log('🔍 Fetching deals from all platforms...');
        const [steamDeals, epicDeals, gogDeals] = await Promise.all([
            fetchSteamDeals(),
            fetchEpicDeals(),
            fetchGOGDeals()
        ]);

        const allDeals = [...steamDeals, ...epicDeals, ...gogDeals];
        console.log(`📦 Steam: ${steamDeals.length} | Epic: ${epicDeals.length} | GOG: ${gogDeals.length}`);

        // 3. Deduplicate and sort by discount
        const seen = new Set<string>();
        const uniqueDeals = allDeals.filter(d => {
            const key = d.name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort((a, b) => b.discount_percent - a.discount_percent);

        console.log(`🎯 Total unique: ${uniqueDeals.length}`);

        // 4. Calculate repost window
        const poolSize = uniqueDeals.length;
        let repostHours = 48;
        if (poolSize >= 50) repostHours = 120;
        else if (poolSize >= 30) repostHours = 72;

        const repostWindow = new Date(Date.now() - repostHours * 60 * 60 * 1000).toISOString();

        // 5. Find first eligible game
        for (const game of uniqueDeals) {
            const { data: existing } = await supabaseAdmin
                .from('posted_games')
                .select('id')
                .eq('game_title', game.name)
                .gt('created_at', repostWindow);

            if (existing && existing.length > 0) {
                console.log(`SKIP: ${game.name} - Posted recently`);
                continue;
            }

            if (!game.header_image) {
                console.log(`SKIP: ${game.name} - No image`);
                continue;
            }

            console.log(`✅ SELECTED: ${game.name} - ${game.discount_percent}% on ${game.platform}`);

            // 6. Fetch image and post
            try {
                const imgRes = await fetch(game.header_image, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (!imgRes.ok) continue;

                const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                const mediaId = await twitterClient.v1.uploadMedia(imgBuffer, { mimeType: 'image/jpeg' });

                // 7. Format Tweet
                const priceStr = game.final_price === 0 ? '🆓 ÜCRETSİZ' : `${game.final_price.toFixed(2)} ₺`;
                const platformEmoji = game.platform === 'Steam' ? '♨️' :
                    game.platform === 'Epic Games' ? '🎮' : '🌌';
                const reviewStr = game.review_percent > 0 ? `⭐ %${game.review_percent} Olumlu\n` : '';

                const tweetText = `🔥 ${game.name}

📉 %${game.discount_percent} İndirim
🏷️ ${priceStr}
${platformEmoji} ${game.platform}
${reviewStr}
🔗 ${game.url}`.trim();

                // 8. Post Tweet
                await twitterClient.v2.tweet({ text: tweetText, media: { media_ids: [mediaId] } });

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`✅ Tweet posted in ${elapsed}s`);

                // 9. Log to DB
                await supabaseAdmin.from('posted_games').insert({
                    app_id: game.id.replace(/^(epic_|gog_)/, '') || '0',
                    game_title: game.name,
                    price_usd: 0
                });

                return NextResponse.json({
                    success: true,
                    game: game.name,
                    platform: game.platform,
                    discount: `${game.discount_percent}%`,
                    price: priceStr,
                    reviews: `${game.review_percent}%`,
                    elapsed: `${elapsed}s`
                });

            } catch (err: any) {
                console.error(`Failed: ${game.name}`, err.message);
                continue;
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        return NextResponse.json({ message: 'No new eligible games.', elapsed: `${elapsed}s` });

    } catch (error: any) {
        console.error('Cron failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

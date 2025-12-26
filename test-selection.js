// Full Test Script - ITAD + Review Filters (like route.ts)
const ITAD_KEY = 'b0a1c3354549db7f5371f9b05de11261634a0aa4';
const MIN_STEAM_REVIEWS = 1000;
const MIN_GOG_REVIEWS = 500;

async function getAppIdFromItad(itadId) {
    try {
        const res = await fetch(`https://api.isthereanydeal.com/games/info/v2?key=${ITAD_KEY}&id=${itadId}`);
        if (res.ok) {
            const data = await res.json();
            return data.appid?.toString() || null;
        }
    } catch (e) { }
    return null;
}

async function getSteamReviews(appId) {
    try {
        const res = await fetch(`https://store.steampowered.com/appreviews/${appId}?json=1&language=all`);
        if (res.ok) {
            const data = await res.json();
            const positive = data.query_summary?.total_positive || 0;
            const total = data.query_summary?.total_reviews || 0;
            if (total > 0) return { count: total, percent: Math.round((positive / total) * 100) };
        }
    } catch (e) { }
    return null;
}

async function fetchSteamDeals() {
    const deals = [];
    const seen = new Set();

    try {
        const res = await fetch('https://store.steampowered.com/api/featuredcategories?cc=tr');
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
                        currency: 'TL',
                        platform: 'Steam',
                        url: `https://store.steampowered.com/app/${item.id}`
                    });
                }
            }
        }
    } catch (e) { console.error('Steam error:', e.message); }

    return deals;
}

async function fetchEpicDeals() {
    const deals = [];

    // Epic Free Games
    try {
        const res = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=tr&country=TR');
        if (res.ok) {
            const data = await res.json();
            const games = data.data?.Catalog?.searchStore?.elements || [];

            for (const game of games) {
                if (!game.title || !game.promotions) continue;
                const promos = game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
                const isFree = promos.some(p => p.discountSetting?.discountPercentage === 0);

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
                            reviews: 10000,
                            url: `https://store.epicgames.com/tr/p/${slug}`
                        });
                    }
                }
            }
        }
    } catch (e) { console.error('Epic free games error:', e.message); }

    // ITAD for Epic sales
    console.log('   🔄 Epic ITAD indirimler kontrol ediliyor...');
    try {
        const res = await fetch(`https://api.isthereanydeal.com/deals/v2?key=${ITAD_KEY}&country=TR&shops=16&limit=30&sort=-cut`);
        if (res.ok) {
            const data = await res.json();
            const itadDeals = data.list || [];

            for (const item of itadDeals) {
                if (item.type === 'game' && item.deal.cut >= 50) {
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
                            reviews: reviews.count,
                            review_percent: reviews.percent,
                            url: `https://store.epicgames.com/tr/p/${item.slug}`
                        });
                    }
                }
            }
        }
    } catch (e) { console.error('Epic ITAD error:', e.message); }

    return deals;
}

async function fetchGOGDeals() {
    const deals = [];

    try {
        const res = await fetch('https://catalog.gog.com/v1/catalog?limit=30&order=desc:discount&productType=in:game');
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
                        reviews: reviewsCount,
                        url: game.storeLink || `https://www.gog.com/en/game/${game.slug}`
                    });
                }
            }
        }
    } catch (e) { console.error('GOG error:', e.message); }
    return deals;
}

async function testSelection() {
    const start = Date.now();
    console.log('🔍 Fetching deals (ITAD + Review Filters)...\n');

    console.log('   📦 Steam Featured...');
    const steamDeals = await fetchSteamDeals();
    console.log(`   ✅ Steam: ${steamDeals.length} oyun`);

    console.log('   📦 Epic Games...');
    const epicDeals = await fetchEpicDeals();
    console.log(`   ✅ Epic: ${epicDeals.length} oyun`);

    console.log('   📦 GOG...');
    const gogDeals = await fetchGOGDeals();
    console.log(`   ✅ GOG: ${gogDeals.length} oyun`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`\n⏱️  Toplam süre: ${elapsed} saniye\n`);

    const allDeals = [...steamDeals, ...epicDeals, ...gogDeals];

    const seen = new Set();
    const uniqueDeals = allDeals.filter(d => {
        const key = d.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    uniqueDeals.sort((a, b) => b.discount_percent - a.discount_percent);

    console.log(`🎯 Toplam benzersiz: ${uniqueDeals.length} oyun\n`);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  🎮 PAYLAŞIMA HAZIR OYUNLAR (Popüler + İndirimli)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    uniqueDeals.slice(0, 20).forEach((deal, i) => {
        const priceStr = deal.final_price === 0 ? '🆓 ÜCRETSİZ' : `${deal.final_price.toFixed(2)} ${deal.currency}`;
        const emoji = deal.platform === 'Steam' ? '♨️' : deal.platform === 'Epic Games' ? '🎮' : '🌌';
        const reviewStr = deal.review_percent ? ` (${deal.review_percent}% olumlu)` : '';
        console.log(`${i + 1}. ${emoji} ${deal.name}${reviewStr}`);
        console.log(`   🏷️  %${deal.discount_percent} → ${priceStr}`);
        console.log(`   🔗 ${deal.url}\n`);
    });

    console.log('📊 Platform Dağılımı:');
    const platforms = {};
    uniqueDeals.forEach(d => platforms[d.platform] = (platforms[d.platform] || 0) + 1);
    Object.entries(platforms).forEach(([p, c]) => console.log(`   ${p}: ${c} oyun`));
}

testSelection().catch(console.error);

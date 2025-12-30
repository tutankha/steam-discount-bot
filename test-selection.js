// Fast Test Script - CheapShark for Epic (No API Key, Fast!)
const MIN_METACRITIC = 60;
const MIN_GOG_REVIEWS = 500;

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

            allItems.forEach(item => {
                if (seen.has(item.id)) return;
                seen.add(item.id);

                if (item.discounted && item.discount_percent >= 25) {
                    deals.push({
                        id: item.id.toString(),
                        name: item.name,
                        discount_percent: item.discount_percent,
                        final_price: item.final_price / 100,
                        currency: 'USD', // Steam returns USD
                        platform: 'Steam',
                        url: `https://store.steampowered.com/app/${item.id}`
                    });
                }
            });
        }
    } catch (e) { console.error('Steam error:', e.message); }

    return deals;
}

async function fetchEpicDeals() {
    const deals = [];

    // Epic Free Games (direct API)
    try {
        const res = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=tr&country=TR');
        if (res.ok) {
            const data = await res.json();
            const games = data.data?.Catalog?.searchStore?.elements || [];

            games.forEach(game => {
                if (!game.title || !game.promotions) return;
                const promos = game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
                const isFree = promos.some(p => p.discountSetting?.discountPercentage === 0);

                if (isFree) {
                    const slug = game.productSlug || game.urlSlug || game.catalogNs?.mappings?.[0]?.pageSlug;
                    if (slug && slug !== '[]') {
                        deals.push({
                            id: `epic_free_${game.id}`,
                            name: game.title,
                            discount_percent: 100,
                            final_price: 0,
                            currency: 'TL',
                            platform: 'Epic Games',
                            metacritic: 90, // Free games are usually good
                            url: `https://store.epicgames.com/tr/p/${slug}`
                        });
                    }
                }
            });
        }
    } catch (e) { console.error('Epic free games error:', e.message); }

    // CheapShark for Epic sales (fast, no API key!)
    try {
        const res = await fetch(`https://www.cheapshark.com/api/1.0/deals?storeID=25&upperPrice=50&onSale=1&pageSize=20&metacritic=${MIN_METACRITIC}`);
        if (res.ok) {
            const data = await res.json();

            data.forEach(game => {
                const discount = Math.round(parseFloat(game.savings) || 0);
                if (discount >= 50) { // Min %50 indirim
                    const alreadyAdded = deals.some(d => d.name.toLowerCase() === game.title.toLowerCase());
                    if (!alreadyAdded) {
                        deals.push({
                            id: `epic_cs_${game.dealID}`,
                            name: game.title,
                            discount_percent: discount,
                            final_price: parseFloat(game.salePrice) || 0,
                            currency: 'USD',
                            platform: 'Epic Games',
                            metacritic: parseInt(game.metacriticScore) || 0,
                            url: `https://store.epicgames.com/tr/browse?q=${encodeURIComponent(game.title)}`
                        });
                    }
                }
            });
        }
    } catch (e) { console.error('CheapShark Epic error:', e.message); }

    return deals;
}

async function fetchGOGDeals() {
    const deals = [];

    try {
        const res = await fetch('https://catalog.gog.com/v1/catalog?limit=20&order=desc:discount&productType=in:game');
        if (res.ok) {
            const data = await res.json();
            const products = data.products || [];

            products.forEach(game => {
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
                        url: game.storeLink || `https://www.gog.com/en/game/${game.slug}`
                    });
                }
            });
        }
    } catch (e) { console.error('GOG error:', e.message); }
    return deals;
}

async function testSelection() {
    const start = Date.now();
    console.log('🔍 Fetching deals (CheapShark for Epic - Fast!)...\n');

    const [steamDeals, epicDeals, gogDeals] = await Promise.all([
        fetchSteamDeals(),
        fetchEpicDeals(),
        fetchGOGDeals()
    ]);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    console.log(`♨️  Steam: ${steamDeals.length} oyun`);
    console.log(`🎮 Epic: ${epicDeals.length} oyun`);
    console.log(`🌌 GOG: ${gogDeals.length} oyun`);
    console.log(`\n⏱️  Toplam süre: ${elapsed} saniye\n`);

    // Normalize names for matching
    const normalizeGameName = name =>
        name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    const allDeals = [...steamDeals, ...epicDeals, ...gogDeals];

    // Keep best deal per game (highest discount, then lowest price)
    const bestDeals = new Map();
    for (const deal of allDeals) {
        const key = normalizeGameName(deal.name);
        const existing = bestDeals.get(key);

        if (!existing) {
            bestDeals.set(key, deal);
        } else {
            const isBetterDiscount = deal.discount_percent > existing.discount_percent;
            const isSameDiscountLowerPrice = deal.discount_percent === existing.discount_percent
                && deal.final_price < existing.final_price;

            if (isBetterDiscount || isSameDiscountLowerPrice) {
                bestDeals.set(key, deal);
            }
        }
    }

    const uniqueDeals = Array.from(bestDeals.values());
    uniqueDeals.sort((a, b) => b.discount_percent - a.discount_percent);

    console.log(`🎯 Toplam benzersiz: ${uniqueDeals.length} oyun\n`);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  🎮 PAYLAŞIMA HAZIR OYUNLAR');
    console.log('═══════════════════════════════════════════════════════════════\n');

    uniqueDeals.slice(0, 25).forEach((deal, i) => {
        const priceStr = deal.final_price === 0 ? '🆓 ÜCRETSİZ' : `${deal.final_price.toFixed(2)} ${deal.currency}`;
        const emoji = deal.platform === 'Steam' ? '♨️' : deal.platform === 'Epic Games' ? '🎮' : '🌌';
        const metaStr = deal.metacritic ? ` (MC: ${deal.metacritic})` : '';
        console.log(`${i + 1}. ${emoji} ${deal.name}${metaStr}`);
        console.log(`   🏷️  %${deal.discount_percent} → ${priceStr}`);
        console.log(`   🔗 ${deal.url}\n`);
    });

    console.log('📊 Platform Dağılımı:');
    const platforms = {};
    uniqueDeals.forEach(d => platforms[d.platform] = (platforms[d.platform] || 0) + 1);
    Object.entries(platforms).forEach(([p, c]) => console.log(`   ${p}: ${c} oyun`));
}

testSelection().catch(console.error);

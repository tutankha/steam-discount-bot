import { TwitterApi } from 'twitter-api-v2';

export const getTwitterClient = () => {
    if (!process.env.TWITTER_APP_KEY ||
        !process.env.TWITTER_APP_SECRET ||
        !process.env.TWITTER_ACCESS_TOKEN ||
        !process.env.TWITTER_ACCESS_SECRET) {
        throw new Error('Missing Twitter credentials');
    }

    return new TwitterApi({
        appKey: process.env.TWITTER_APP_KEY,
        appSecret: process.env.TWITTER_APP_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
    });
};

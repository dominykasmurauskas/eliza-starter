export interface ScraperState {
    lastScrapedTweets: Record<string, string>; // username -> last tweet ID
    lastUpdated: number;
}
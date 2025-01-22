import { IAgentRuntime, elizaLogger, stringToUuid } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { ScraperState } from "./types.ts";

export class TwitterScraper {
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private scrapeInterval: number;
    private targetAccounts: string[];
    private isRunning: boolean = false;
    private lastScrapedTweets: Map<string, string> = new Map(); // username -> last tweet ID
    private readonly stateId = "twitter-scraper-state";

    constructor(client: ClientBase, runtime: IAgentRuntime, scrapeInterval: number, targetAccounts: string[]) {
        this.client = client;
        this.runtime = runtime;
        this.scrapeInterval = scrapeInterval;
        this.targetAccounts = targetAccounts;
    }

    async start() {
        if (this.isRunning) {
            elizaLogger.warn("Twitter scraper is already running");
            return;
        }

        try {
            this.isRunning = true;
            elizaLogger.info("Twitter scraper starting...");

            // Initialize the client first
            await this.client.init();
            elizaLogger.info("Twitter client initialized");

            // Load persisted state
            await this.loadState();
            await this.initializeLastScrapedTweets();

            // Start periodic scraping in the background
            setTimeout(() => {
                this.scrapeData().catch(error => {
                    elizaLogger.error("Error during initial scrape:", error);
                });
            }, 0);

            setInterval(() => {
                this.scrapeData().catch(error => {
                    elizaLogger.error("Error during periodic scrape:", error);
                });
            }, this.scrapeInterval);

            elizaLogger.info("Twitter scraper started successfully");
        } catch (error) {
            this.isRunning = false;
            elizaLogger.error("Failed to start Twitter scraper:", error);
            throw error;
        }
    }

    private async loadState() {
        try {
            const state = await this.runtime.ragKnowledgeManager.getKnowledge({
                id: stringToUuid(this.stateId),
            });

            if (state.length > 0) {
                const scraperState = JSON.parse(state[0].content.text) as ScraperState;
                // Convert record to Map
                Object.entries(scraperState.lastScrapedTweets).forEach(([username, tweetId]) => {
                    this.lastScrapedTweets.set(username, tweetId);
                });
                elizaLogger.info("Loaded persisted scraper state");
            }
        } catch (error) {
            elizaLogger.error("Failed to load scraper state:", error);
        }
    }

    private async saveState() {
        try {
            // Convert Map to record for JSON serialization
            const state: ScraperState = {
                lastScrapedTweets: Object.fromEntries(this.lastScrapedTweets),
                lastUpdated: Date.now()
            };

            await this.storeKnowledge(this.stateId, JSON.stringify(state, null, 2));
            elizaLogger.info("Saved scraper state");
        } catch (error) {
            elizaLogger.error("Failed to save scraper state:", error);
        }
    }

    private async initializeLastScrapedTweets() {
        for (const username of this.targetAccounts) {
            // Skip if we already have this username's state
            if (this.lastScrapedTweets.has(username)) {
                continue;
            }

            try {
                const existingTweets = await this.runtime.ragKnowledgeManager.getKnowledge({
                    id: stringToUuid(`${username}-tweets`),
                });

                if (existingTweets.length > 0) {
                    const tweets = JSON.parse(existingTweets[0].content.text) as any[];
                    if (tweets.length > 0) {
                        // Store the most recent tweet ID
                        this.lastScrapedTweets.set(username, tweets[0].id);
                        elizaLogger.info(`Initialized last tweet ID for ${username}: ${tweets[0].id}`);
                    }
                }
            } catch (error) {
                elizaLogger.error(`Failed to initialize last tweet for ${username}:`, error);
            }
        }
    }

    private formatProfileForRAG(profile: any): string {
        const sections = [
            `Twitter Profile: @${profile.username}`,
            `Name: ${profile.name}`,
            `Bio: ${profile.biography}`,
            
            // Engagement metrics
            `Metrics:`,
            `- Followers: ${profile.followersCount.toLocaleString()}`,
            `- Following: ${profile.friendsCount.toLocaleString()}`,
            `- Total Tweets: ${profile.tweetsCount.toLocaleString()}`,
            `- Media Posts: ${profile.mediaCount.toLocaleString()}`,
            `- Likes Given: ${profile.likesCount.toLocaleString()}`,
            `- Listed In: ${profile.listedCount.toLocaleString()}`,
            
            // Account details
            `Account Details:`,
            `- Joined: ${profile.joined}`,
            `- Location: ${profile.location || 'Not specified'}`,
            `- Website: ${profile.website || 'Not specified'}`,
            
            // Verification status
            `Status:`,
            `- Verified: ${profile.isVerified ? 'Yes' : 'No'}`,
            `- Twitter Blue: ${profile.isBlueVerified ? 'Yes' : 'No'}`,
            `- Private Account: ${profile.isPrivate ? 'Yes' : 'No'}`,
            
            // Media links
            `Media:`,
            `- Avatar: ${profile.avatar}`,
            profile.banner ? `- Banner: ${profile.banner}` : null,
            
            // Pinned content
            profile.pinnedTweetIds?.length ? `Pinned Tweets: ${profile.pinnedTweetIds.join(', ')}` : null,
        ];

        return sections.filter(Boolean).join('\n');
    }

    private formatTweetForRAG(tweet: any): string {
        const timestamp = tweet.timeParsed || new Date(tweet.timestamp * 1000).toISOString();
        let content = '';

        if (tweet.isRetweet && tweet.retweetedStatus) {
            content = `Retweet by @${tweet.username} (${timestamp})
Original tweet by @${tweet.retweetedStatus.username}:
${tweet.retweetedStatus.text}

Original Engagement: ${tweet.retweetedStatus.likes} likes, ${tweet.retweetedStatus.retweets} retweets, ${tweet.retweetedStatus.replies} replies`;
        } else {
            content = `Tweet by @${tweet.username} (${timestamp})
${tweet.text}

Engagement: ${tweet.likes} likes, ${tweet.retweets} retweets, ${tweet.replies} replies`;
        }

        if (tweet.photos?.length > 0) {
            content += `\nPhotos: ${tweet.photos.join(', ')}`;
        }

        if (tweet.videos?.length > 0) {
            content += `\nVideos: ${tweet.videos.join(', ')}`;
        }

        if (tweet.urls?.length > 0) {
            content += `\nLinks: ${tweet.urls.join(', ')}`;
        }

        if (tweet.hashtags?.length > 0) {
            content += `\nHashtags: ${tweet.hashtags.join(' ')}`;
        }

        return content;
    }

    private async scrapeData() {
        for (const username of this.targetAccounts) {
            try {
                elizaLogger.info(`Starting to scrape data for ${username}`);

                // Get user profile
                const profile = await this.client.getUserProfile(username);
                if (!profile) {
                    throw new Error(`Failed to fetch profile for ${username}`);
                }

                elizaLogger.info(`Fetched profile for ${username}`, { profile });
                const formattedProfile = this.formatProfileForRAG(profile);
                await this.storeKnowledge(`${username}-profile`, formattedProfile);
                elizaLogger.info(`Scraped profile for ${username}`);

                // Get user tweets
                const tweets = await this.client.getUserTweets(username);
                if (!tweets || tweets.length === 0) {
                    elizaLogger.info(`No tweets found for ${username}`);
                    continue;
                }

                const lastScrapedId = this.lastScrapedTweets.get(username);
                const newTweets = lastScrapedId
                    ? tweets.filter(tweet => tweet.id > lastScrapedId)
                    : tweets;

                for (const tweet of newTweets) {
                    try {
                        if (!tweet || !tweet.id) continue;

                        elizaLogger.info(`Formatting tweet ${tweet.id}`, tweet);
                        const formattedContent = this.formatTweetForRAG(tweet);
                        await this.storeKnowledge(`tweet-${tweet.id}`, formattedContent);
                        elizaLogger.info(`Stored tweet ${tweet.id}`);
                    } catch (tweetError) {
                        elizaLogger.error(`Failed to process tweet ${tweet?.id}:`, {
                            error: tweetError,
                            tweet: JSON.stringify(tweet, null, 2)
                        });
                    }
                }

                if (newTweets.length > 0) {
                    this.lastScrapedTweets.set(username, newTweets[0].id);
                    await this.saveState();
                }

            } catch (error) {
                elizaLogger.error(`Failed to scrape data for ${username}:`, error);
            }
        }
    }

    private async storeKnowledge(id: string, content: string) {
        try {
            // Check if knowledge with this ID already exists
            const existing = await this.runtime.ragKnowledgeManager.getKnowledge({
                id: stringToUuid(id),
            });

            // If content is the same, skip storing
            if (existing.length > 0 && existing[0].content.text === content) {
                elizaLogger.info(`Knowledge ${id} unchanged, skipping update`);
                return;
            }

            // If there's existing knowledge, delete it first
            if (existing.length > 0) {
                await this.runtime.ragKnowledgeManager.removeKnowledge(stringToUuid(id));
                elizaLogger.info(`Deleted old knowledge ${id}`);
            }

            // Store new knowledge
            await this.runtime.ragKnowledgeManager.createKnowledge({
                id: stringToUuid(id),
                agentId: this.runtime.agentId,
                content: {
                    text: content,
                    metadata: {
                        source: "twitter-readonly",
                        type: "text",
                        createdAt: Date.now(),
                        isShared: true
                    },
                },
            });
            elizaLogger.info(`Stored new knowledge ${id}`);
        } catch (error) {
            elizaLogger.error(`Failed to store knowledge for ${id}:`, error);
            throw error;
        }
    }
}
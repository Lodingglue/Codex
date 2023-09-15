import { redis } from '$lib/server/redis';
import { META } from '@consumet/extensions';
import { proxyUrl, formatDetails } from '$lib/utils';

export async function load({ fetch, params, url }) {
	const episodeNumber = url.searchParams.get('episode') || 1;
	const detailsCacheKey = `details-${params.id}`;
	const episodeCacheKey = `watch-${params.id}-${episodeNumber}`;

	try {
		const anilistMeta = new META.Anilist(undefined, { url: proxyUrl });
		let details = null;
		const detailsAnilistCached = await redis.get(detailsCacheKey);

		if (!detailsAnilistCached) {
			const [enimeResp, anilistResp] = await Promise.all([
				fetch(`https://api.enime.moe/mapping/anilist/${params.id}`),
				fetch('https://graphql.anilist.co/', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json'
					},
					body: JSON.stringify({
						query: await (await fetch('../graphql/details.graphql')).text(),
						variables: { id: params.id }
					})
				})
			]);

			const enimeCacheControl = enimeResp.headers.get('cache-control');

			if (enimeCacheControl) {
				setHeaders({ 'cache-control': enimeCacheControl });
			}

			const enime = await enimeResp.json();
			const anilist = await anilistResp.json();

			details = formatDetails(anilist.data.Media, enime);
			redis.set(detailsCacheKey, JSON.stringify(details), 'EX', 600);
		} else if (detailsAnilistCached) {
			details = JSON.parse(detailsAnilistCached);
		}

		let currentEpObject = details.episodes.find(
			(episode) => parseInt(episode.number) == parseInt(episodeNumber)
		);

		const episodeCached = await redis.get(episodeCacheKey);
		let episodeUrlsSub;
		let episodeUrlsDub;
		if (!episodeCached) {
			const currentEpIdSub = currentEpObject.sources[0].target;
			const currentEpIdDub = currentEpIdSub.replace('episode', 'dub-episode');

			[episodeUrlsSub, episodeUrlsDub] = await Promise.all([
				anilistMeta.fetchEpisodeSources(currentEpIdSub),
				anilistMeta.fetchEpisodeSources(currentEpIdDub).catch((error) => null) // Handle errors and set to null
			]);
			redis.set(
				episodeCacheKey,
				JSON.stringify({
					episodeUrlsSub,
					episodeUrlsDub
				}),
				'EX',
				600
			);
		} else if (episodeCached) {
			const episodeCachedObject = JSON.parse(episodeCached);
			episodeUrlsSub = episodeCachedObject.episodeUrlsSub;
			episodeUrlsDub = episodeCachedObject.episodeUrlsDub;
		}
		currentEpObject.sourcesSub = episodeUrlsSub?.sources;
		currentEpObject.sourcesDub = episodeUrlsDub?.sources;

		return {
			animeDetails: details,
			currentEpObject
		};
	} catch (error) {
		console.error('An error occurred:', error);
		throw error;
	}
}

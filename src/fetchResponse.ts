// This file is part of cresolve, copyright (c) 2018- BusFaster Ltd.
// Released under the MIT license, see LICENSE.

export interface FetchResponse {
	ok: boolean;
	url: string;
	text: () => Promise<string>;
}

export function fetchResponse(data: string, url: string) {
	return({
		ok: true,
		url,
		text: () => Promise.resolve(data)
	} as FetchResponse);
}

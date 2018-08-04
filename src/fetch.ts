import * as FS from 'fs';
import * as URL from 'url';
import * as HTTP from 'http';

export const isNode = (
	typeof(process) == 'object' &&
	Object.prototype.toString.call(process) == '[object process]'
);

export const isWin = (
	isNode &&
	typeof(process.platform) == 'string' &&
	process.platform.substr(0, 3) == 'win'
);

export function url2path(urlPath: string) {
	let nativePath = urlPath.replace(/^file:\/\//, '');

	if(isWin) {
		if(nativePath.match(/^\/[0-9A-Za-z]+:\//)) nativePath = nativePath.substr(1);
		nativePath = nativePath.replace(/\//g, '\\');
	}

	return(nativePath);
}

export function path2url(nativePath: string) {
	let urlPath = nativePath;

	if(isWin) {
		urlPath = urlPath.replace(/\\/g, '/');
		if(urlPath.match(/^[0-9A-Za-z]+:\//)) urlPath = '/' + urlPath;
	}

	return(urlPath.replace(/^\//, 'file:///'));
}

export const redirectCodes: { [code: number]: boolean } = {
	301: true,
	302: true,
	303: true,
	307: true,
	308: true
}

export function request(uri: string, head?: boolean, ttl = 3) {
	const result = new Promise((resolve: (result: { uri: string, text: string } | Promise<{ uri: string, text: string }>) => void, reject) => {
		if(!ttl) reject(new Error('Too many redirects'));

		const proto = uri.substr(0, 7).toLowerCase();

		let http: typeof HTTP;
		if(proto == 'http://') http = eval("require('http')");
		else if(proto == 'https:/') http = eval("require('https')");
		else return(reject(new Error()));

		const url: typeof URL = eval("require('url')");

		const options: HTTP.RequestOptions = url.parse(uri);
		if(head) options.method = 'HEAD';

		const req = http.request(options, (res: HTTP.IncomingMessage) => {
			if(res.statusCode == 200) {
				if(head) {
					req.abort();
					return(resolve({ uri, text: '' }));
				}

				const chunkList: Buffer[] = [];

				res.on('error', reject);
				res.on('data', (chunk: Buffer) => chunkList.push(chunk));
				res.on('end', () => resolve({ uri, text: Buffer.concat(chunkList).toString('utf-8') }));
			} else if(!res.statusCode || !redirectCodes[res.statusCode]) {
				req.abort();
				return(reject(res));
			} else {
				const next = res.headers.location;

				req.abort();
				if(!next) return(reject(res));

				return(resolve(request(url.resolve(uri, next), head, ttl - 1)));
			}
		});

		req.on('error', reject);
		req.end();
	});

	return(result);
}

export function ifExists(uri: string) {
	const proto = uri.substr(0, 7).toLowerCase();
	console.log('Testing existence: ' + uri);

	const result = new Promise((
		resolve: (result: string | Promise<string>) => void,
		reject
	) => {
		if(!isNode) {
			const xhr = new XMLHttpRequest();

			xhr.onerror = reject;
			xhr.onload = () => xhr.status != 200 ? reject(xhr) : resolve(uri);

			xhr.open('HEAD', uri, true);
			xhr.send(null);		
		} else if(proto == 'file://') {
			const fs: typeof FS = eval("require('fs')");

			fs.stat(
				url2path(uri),
				(err: NodeJS.ErrnoException, stat: FS.Stats) => err ? reject(err) : resolve(uri)
			);
		} else {
			resolve(request(uri, true).then(() => uri));
		}
	});

	return(result);
}

function fetchResponse(data: string, url: string) {
	return({
		ok: true,
		url,
		text: () => Promise.resolve(data)
	});
}

export function fetch(uri: string) {
	const proto = uri.substr(0, 7).toLowerCase();
	console.log('Fetching: ' + uri);

	const result = new Promise((
		resolve: (result: { text: () => Promise<string> } | Promise<{ text: () => Promise<string> }>) => void,
		reject
	) => {
		if(!isNode) {
			const xhr = new XMLHttpRequest();

			xhr.onerror = reject;
			xhr.onload = () => xhr.status != 200 ? reject(xhr) : resolve(fetchResponse(xhr.responseText, xhr.responseURL));

			xhr.open('GET', uri, true);
			xhr.send(null);		
		} else if(proto == 'file://') {
			const fs: typeof FS = eval("require('fs')");

			fs.readFile(
				url2path(uri),
				'utf-8',
				(err: NodeJS.ErrnoException, data: string) => err ? reject(err) : resolve(fetchResponse(data, uri))
			);
		} else {
			resolve(request(uri).then(({ uri, text }) => fetchResponse(text, uri)));
		}
	});

	return(result);
}

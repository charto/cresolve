// This file is part of cresolve, copyright (c) 2018- BusFaster Ltd.
// Released under the MIT license, see LICENSE.

import * as SystemJS from 'systemjs';

import { PathTree } from './PathTree';
import { FetchResponse, fetchResponse } from './fetchResponse';

/** Parts of SystemJS configuration that this tool can autogenerate. */

export interface SystemConfig {
	map?: { [name: string]: string };
	meta?: { [name: string]: any };
	packages: { [name: string]: any };
};

/** Parts of SystemJS configuration this tool modifies for any package resolved. */

export interface GeneratedConfig extends SystemConfig {
	map: { [name: string]: string };
	meta: { [name: string]: any };
};

/** Promise for an RPC message response and methods to set it when
  * the response arrives. */

type MessageHandler<Type> = {
	promise: Promise<Type>,
	resolve: (result: Type) => void,
	reject: (result: string) => void
};

/** Cache mapping URLs to pending and fulfilled RPC message responses. */

type HandlerCache<Type> = { [uri: string]: MessageHandler<Type> };

/** Method to call in resolver internal RPC between Web Workers and UI thread. */

const enum METHOD {
	/** Request from / response to worker:
	  * check file existence using UI thread cache. */
	ifExists,

	/** Request from / response to worker:
	  * fetch file using UI thread cache. */
	fetch,

	/** Web Worker initialization success / failure signal. */
	loaded,

	/** Configuration change from worker, for UI thread to save in SessionStorage. */
	config
}

/** Resolver internal RPC message between Web Workers and UI thread. */

interface ResolverMessage {
	method: METHOD;
	uri: string;
	success?: boolean;
	target?: string;
	body?: string;
	config?: any;
}

function deepExtend(dst: { [key: string]: any }, src: { [key: string]: any }) {
	for(let key of Object.keys(src)) {
		if(typeof(dst[key]) == 'object') deepExtend(dst[key], src[key]);
		else dst[key] = src[key];
	}
}

function semverMax(list: string[]) {
	let result = list[0].split('.');

	for(let num = 1; num < list.length; ++num) {
		const other = list[num].split('.');
		const partCount = Math.min(result.length, other.length);
		let partNum = 0;

		while(partNum < partCount) {
			const part = result[partNum].replace(/^[ <=>~^]+ */, '');
			const otherPart = other[partNum++].replace(/^[ <=>~^]+ */, '');

			if(otherPart > part) result = other;
			if(otherPart < part) break;
		}

		if(partNum >= partCount && other.length > partCount) result = other;
	}

	return(result.join('.'));
}

export class Resolver {

	/** @param ifExists Function returning a promise resolving to an URL
	  *   address if it exists (after all redirections), rejected otherwise.
	  * @param fetch The standard fetch function or a compatible polyfill.
	  * @param systemConfig Optional initial SystemJS configuration. */

	constructor(
		public ifExists: (uri: string) => Promise<string>,
		public fetch: (uri: string, config?: any) => Promise<FetchResponse>,
		public systemConfig: GeneratedConfig = { map: {}, meta: {}, packages: {} }
	) {}

	private findStep(packageRoot: string, alternatives: string[]): Promise<string> {
		const next = alternatives.pop();
		const result = this.ifExists(packageRoot + '/package.json').then(
			(uri: string) => packageRoot,
			() => next ? this.findStep(next, alternatives) : Promise.reject(null)
		);

		return(result);
	}

	/** Find URL address of an npm package root directory
	  * (without slash at the end).
	  *
	  * @param name Name of npm package to find.
	  * @param guess URL address SystemJS thought was inside the package.
	  * @param alternatives Fallback array of possible package root URLs. */

	private findPackageRoot(
		guess: string,
		alternatives: string[] = [],
		name?: string
	) {
		const container = 'node_modules';
		let first: string | undefined;
		const guessLow = guess.toLowerCase();
		const nameLow = name && name.toLowerCase();
		let prevPrev: number | undefined;
		let prev = guessLow.length;
		let end: number;

		while((end = guessLow.lastIndexOf('/', prev)) >= 0) {
			const part = guessLow.substr(end + 1, prev - end);

			if(part == container) { if(!first && prevPrev) end = prevPrev + 1; first = void 0; break; }
			if(first) { end = prev + 1; break; }
			if(part == nameLow || part == nameLow + '.js') first = guess.substr(0, prev + 1);

			prevPrev = prev;
			prev = end - 1;
		}

		if(end < 0) end = guess.length;

		prev = guess.indexOf('//') + 2;
		let pos;

		do {
			pos = guess.indexOf('/', prev) + 1 || end + 1;
			const part = guessLow.substr(prev, pos - prev - 1);

			if(part != container) {
				alternatives.push(
					guess.substr(0, pos - 1) +
					(name ? '/node_modules/' + name : '')
				);
			}

			prev = pos;
		} while(pos < end);

		if(first) {
			// If the guessed path contained the package name,
			// try that directory first.

			alternatives.push(first);
		}

		return(this.findStep(alternatives.pop()!, alternatives));
	}

	/** Send generated configuration to SystemJS,
	  * and to UI thread if inside a Web Worker. */

	private applyConfig(sys: typeof SystemJS) {
		sys.config(this.pending);

		if(this.port) {
			this.port.postMessage({
				method: METHOD.config,
				config: this.pending
			});
		}

		this.pending = { packages: {} };
	}

	/** Fetch package.json and track redirects.
	  *
	  * @param root Package root address.
	  * @return Object with fields:
	  *   - data: package.json contents as a string.
	  *   - root: Packare root address after redirections. */

	private loadPackage(root: string) {
		const result = this.fetch(
			root + '/package.json',
			{ cache: 'force-cache' }
		).then((res: FetchResponse) => {
			root = res.url.replace(/\/package\.json$/i, '');
			return(res.text());
		}).then((data: string) => ({ data, root }));

		return(result);
	}

	private generateName() {
		return('ANONYMOUS-' + ++this.suffix);
	}

	/** Parse package.json, apply any SystemJS configuration found and resolve
	  * package entry point or a path relative to the package root.
	  *
	  * @param sys SystemJS object to configure.
	  * @param data package.json contents as a string.
	  * @param rootAddress Package root address.
	  * @param packageName Name of the package if already known.
	  * @param pathName Path to resolve from package root.
	  * @return Resolved path inside package or package main entry point. */

	private parsePackage(
		sys: typeof SystemJS,
		data: string,
		rootAddress: string,
		packageName?: string,
		pathName?: string
	) {
		const config = this.systemConfig;
		const pending = this.pending;
		const pkg = JSON.parse(data);
		let main = pkg.main || 'index.js';

		// Get package name from path in import statement or package.json.
		// If neither is available, generate a new name.

		packageName = (packageName || pkg.name || this.generateName()) as string;

		// Insert package root into virtual directory tree and get previous
		// package name to avoid multiple different generated names.

		packageName = this.packageTree.insert(rootAddress, packageName)['/data']!;
		this.jsonTbl[packageName] = pkg;

		// Remove last path component (including surrounding slashes)
		// if it follows node_modules or a hostname.

		const modulesRoot = rootAddress.replace(/(\/node_modules|:\/\/[^/]+)\/[^/]*\/?$/i, '$1');
		const modulesGlob = modulesRoot + '/\*';

		if(!config.meta[modulesGlob]) {
			config.meta[modulesGlob] = {
				globals: { process: 'global:process' }
			};

			config.packages[modulesRoot] = {
				defaultExtension: 'js'
			};

			if(!pending.meta) pending.meta = {};
			if(!pending.packages) pending.packages = {};

			pending.meta[modulesGlob] = config.meta[modulesGlob];
			pending.packages[modulesRoot] = config.packages[modulesRoot];
		}

		config.map[packageName] = rootAddress;

		if(!pending.map) pending.map = {}
		pending.map[packageName] = config.map[packageName];

		let subConfig = config.packages[packageName];

		if(!subConfig) {
			subConfig = {};
			config.packages[packageName] = subConfig;
		}

		subConfig.main = main;

		if(typeof(pkg.browser) == 'string') {
			// Use browser entry point.
			if(pathName == main) pathName = pkg.browser;
			main = pkg.browser;
		} else if(typeof(pkg.browser) == 'object') {
			// Use browser equivalents of packages and files.
			if(!subConfig.map) subConfig.map = {};

			// Add mappings from package.json browser field to SystemJS
			// config, where they get parsed.

			for(let key of Object.keys(pkg.browser)) {
				subConfig.map[key] = pkg.browser[key] || '@empty';
			}
		}

		for(let key of Object.keys(pkg.dependencies || {})) {
			if(!this.versionTbl[key]) {
				this.versionTbl[key] = semverMax(
					pkg.dependencies[key].split(/ *\|\| *| +(- +)?/)
				);
			}
		}

		if(packageName == 'typescript') {
			// Fix incorrect module type autodetection due to comments
			// containing ES6 code.

			if(!subConfig.meta) subConfig.meta = {};
			subConfig.meta['*.js'] = { exports: 'ts', format: 'global' };
		}

		pending.packages[packageName] = subConfig;
		this.applyConfig(sys);

		pathName = pathName || main;

		return((rootAddress + '/' + pathName).replace(/(\/[^./]+)$/, '$1.js'));
	}

	/** Look for and parse package.json for package containing a path,
	  * applying any SystemJS configuration found.
	  *
	  * @param pathName Path possibly inside a package.
	  * @return Package root path (without slash at the end) or just the parent
	  *   directory if no package.json was found higher in the tree. */

	private getContainingPackage(sys: typeof SystemJS, pathName: string) {
		const node = this.packageTree.find(pathName);

		const result: Promise<typeof node | void> = node ? Promise.resolve(node) : this.findPackageRoot(
			pathName
		).then(
			(root: string) => this.loadPackage(root)
		).then(({ data, root }) => {
			this.parsePackage(sys, data, root);
		}).catch(() => {
			// If no package.json was found higher in the tree,
			// just use the parent directory as the package root.

			const rootAddress = pathName.replace(/\/[^/]*\/?$/, '');
			this.packageTree.insert(rootAddress, this.generateName());
		});

		return(result);
	}

	/** Use Node.js module resolution to find a file SystemJS
	  * resolved incorrectly (ifExists reported the file missing).
	  * If possible, reconfigure SystemJS to work correctly.
	  *
	  * @param name Original path in import command.
	  * @param guess Incorrect URL address resolved by SystemJS.
	  * @param sys SystemJS object. */

	private findFile(
		sys: typeof SystemJS,
		name: string,
		parentAddress: string,
		guess: string
	) {
		const config = this.systemConfig;
		let rootFound: Promise<string>;
		let packageName: string | undefined;
		let pathName: string | undefined;

		if(name.match(/^\.\.?(\/|$)/)) {
			// Handle importing packages through paths like '.' or '..'
			// or './something' (always starting with './), looking for a
			// package.json inside. Remove final slash or file extension
			// (maybe accidentally added to a directory name by SystemJS).

			rootFound = Promise.resolve(guess.replace(/(\/|\.[a-z]+)$/, ''));
		} else {
			// Parse imports that start with an npm package name.
			const parts = name.match(/^((@[0-9a-z][-_.0-9a-z]*\/)?[0-9a-z][-_.0-9a-z]*)(\/(.*))?/);

			if(!parts) {
				throw(new Error('Cannot parse missing dependency using Node.js module resolution: ' + name));
			}

			// Match 'name' or '@scope/name'.
			packageName = parts[1];

			// Match 'path/inside/package'.
			pathName = parts[4];

			rootFound = (
				// First look for configuration of the package that called import,
				// ensuring browser mappings and dependency versions of the app
				// main package.json get parsed.

				parentAddress ? this.getContainingPackage(sys, parentAddress) : Promise.resolve()
			).then(() => this.findPackageRoot(
				guess,
				[ 'https://unpkg.com/' + packageName + '@' + (this.versionTbl[packageName!] || 'latest') ],
				packageName
			)).catch(() => Promise.reject(
				new Error('Cannot find root of package using Node.js module resolution: ' + packageName)
			));
		}

		const result = rootFound.then(
			(root: string) => this.loadPackage(root)
		).then(({ data, root }) =>
			this.parsePackage(sys, data, root, packageName, pathName)
		);

		return(result);
	}

	systemResolve(
		sys: typeof SystemJS,
		name: string,
		parentAddress: string,
		originalResolve: typeof SystemJS.resolve
	) {
		const config = this.systemConfig;
		let uri: string;
		let otherUri: string;

		const findAlternatives = (base: string) => {
			uri = base;

			if(uri.match(/\.ts$/)) otherUri = uri + 'x';
			else otherUri = uri.replace(/(\.js)?$/, '/index.js');

			if(sys.registry.get(uri)) return(uri);
			if(sys.registry.get(otherUri)) return(otherUri);

			// Check if the dependency path is an existing .js file, or
			// directory containing index.js. For .ts files try .tsx extension.

			return(this.ifExists(uri).catch(() => this.ifExists(otherUri)));
		};

		const result = originalResolve.call(sys, name, parentAddress).then(findAlternatives).catch(
			// Try to find the dependency using npm-style resolution.
			() => this.findFile(sys, name, parentAddress, uri).then(findAlternatives)
		).then((resolved: string) => {
			// Ensure SystemJS is prepared to load the correct file
			// even if autoconfiguration failed.
			const prepared: Promise<string> = originalResolve.call(
				sys,
				resolved,
				parentAddress
			);

			if(resolved != otherUri) return(prepared);

			// If the path was a directory containing index.js or a .tsx file,
			// add a mapping with the correct path to SystemJS config.

			const configured = this.getContainingPackage(sys, otherUri).then((other) => {
				if(!other) other = this.packageTree.find(otherUri)!;

				const pending = this.pending;
				const packageName = other.node!['/data']!;

				if(!config.map[packageName]) {
					config.map[packageName] = otherUri.substr(0, other.next!);

					if(!pending.map) pending.map = {}
					pending.map[packageName] = config.map[packageName];
				}

				let subConfig = config.packages[packageName];

				if(!subConfig) {
					subConfig = {};
					config.packages[packageName] = subConfig;
				}

				if(!subConfig.map) subConfig.map = {};
				subConfig.map['.' + uri.substr(other.next!)] = '.' + otherUri.substr(other.next!);

				pending.packages[packageName] = subConfig;
				this.applyConfig(sys);

				return(prepared);
			});

			return(configured);
		});

		return(result);
	}

	patchSystem(sys: typeof SystemJS, env = 'production') {
		const originalResolve = sys.resolve;
		const resolver = this;

		// Set up a special URI for finding a shim module for the global
		// process object, required by some npm packages even in browsers.

		sys.set('global:process', sys.newModule({ env: { 'NODE_ENV': env } }));

		// Hook SystemJS path resolution to detect missing files and try
		// to add mappings according to Node.js module resolution.

		sys.resolve = function(
			this: typeof SystemJS,
			name: string,
			parentAddress: string,
		) {
			return(resolver.systemResolve(this, name, parentAddress, originalResolve));
		};

		return(this);
	}

	/** Called from the UI thread. Create a message channel port for
	  * passing to a Web Worker, so it can defer all file fetches to the
	  * UI thread, which has access to SessionStorage for caching results
	  * between page loads.
	  * As an additional feature, resolves a promise to given
	  * result if the worker reports initialization success.
	  *
	  * @param sys SystemJS object to configure with any updates sent
	  *   from the worker.
	  * @param resolve Promise resolver to call if the worker reports
	  *   initialization success through this resolver's RPC channel.
	  * @param reject Called if the worker reports initialization failure.
	  * @param result Value the promise resolver should be called with. */

	createPort<Result>(
		sys: typeof SystemJS,
		resolve: (result: Result) => void,
		reject: () => void,
		result: Result
	) {
		const channel = new MessageChannel();
		const local = channel.port1;

		local.onmessage = (event) => {
			const req: ResolverMessage = event.data;
			const method = req.method;

			function send(success: boolean, target?: string, body?: string) {
				const res: ResolverMessage = { method, uri: req.uri, success };

				if(target) res.target = target;
				if(body) res.body = body;

				local.postMessage(res);
			}

			switch(method) {
				case METHOD.ifExists:
					this.ifExists(req.uri).then(
						function(uri) { send(true, uri); },
						function(err) { send(false); }
					);
					break;

				case METHOD.fetch:
					this.fetch(req.uri, req.config || {}).then(
						function(res) { res.text().then(function(body) { send(true, res.url, body); }); },
						function(err) { send(false); }
					);
					break;

				case METHOD.loaded:
					if(req.success) resolve(result);
					else reject();
					break;

				case METHOD.config:
					// Additional autogenerated config from a Web Worker.

					deepExtend(this.systemConfig, req.config);
					sys.config(req.config);
					break;
			}
		}

		return(channel.port2);
	}

	setPort(port: MessagePort) {
		function createHandler<Type>(method: METHOD, cache: HandlerCache<Type>) {
			return(function(uri: string, config?: any) {
				let handler = cache[uri];

				if(!handler) {
					handler = {} as any;

					handler.promise = new Promise((resolve: (result: Type) => void, reject) => {
						handler.resolve = resolve;
						handler.reject = reject;
						port.postMessage({ method: method, uri, config });
					});

					cache[uri] = handler;
				}

				return(handler.promise);
			});
		}

		this.existsCache = {};
		this.fetchCache = {};

		this.port = port;
		this.ifExists = createHandler<string>(METHOD.ifExists, this.existsCache);
		this.fetch = createHandler(METHOD.fetch, this.fetchCache);

		port.onmessage = (event) => {
			const res: ResolverMessage = event.data;
			let handler: MessageHandler<any> | undefined;

			switch(res.method) {
				case METHOD.ifExists:
					const existsHandler = this.existsCache[res.uri];
					handler = existsHandler;

					if(res.success) {
						return(existsHandler.resolve(res.target!));
					}
					break;

				case METHOD.fetch:
					const fetchHandler = this.fetchCache[res.uri];
					handler = fetchHandler;

					if(res.success) {
						return(fetchHandler.resolve(fetchResponse(res.body!, res.target!)));
					}
					break;

				default:
					return;
			}

			handler.reject('');
		}
	}

	/** Call in Web Worker initialization to report success / failure
	  * to UI thread. Allows these loader messages to piggyback on the
	  * resolver's internal RPC channel. */

	reportLoad(success: boolean) {
		this.port.postMessage({ method: METHOD.loaded, success });
	}

	/** Web Worker side message channel port for RPC messages. */
	private port: MessagePort;

	/** Cache (used in workers) mapping URLs to ifExists RPC message responses. */
	private existsCache: HandlerCache<string>;

	/** Cache (used in workers) mapping URLs to fetch RPC message responses. */
	private fetchCache: HandlerCache<FetchResponse>;

	private packageTree = new PathTree<string>();

	/** New configuration object not yet used in SystemJS. */
	private pending: SystemConfig = { packages: {} };

	/** Serial number of generated package names. */
	private suffix = 0;

	versionTbl: { [name: string]: string } = {};

	/** Cache mapping package names to their package.json contents. */
	jsonTbl: { [name: string]: Object } = {};

}

import * as SystemJS from 'systemjs';

import { PathTree } from './PathTree';
import { FetchResponse, fetchResponse } from './fetchResponse';

export interface PackageLocation {
	modulesRoot: string;
	name: string;
}

export interface SystemConfig {
	map?: { [name: string]: string };
	meta?: { [name: string]: any };
	packages: { [name: string]: any };
};

export interface GeneratedConfig extends SystemConfig {
	map: { [name: string]: string };
	meta: { [name: string]: any };
};

type MessageHandler<Type> = {
	promise: Promise<Type>,
	resolve: (result: Type) => void,
	reject: (result: string) => void
};

type HandlerCache<Type> = { [uri: string]: MessageHandler<Type> };

const enum METHOD {
	ifExists,
	fetch,
	loaded,
	config
}

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

export class Resolver {

	constructor(
		public ifExists: (uri: string) => Promise<string>,
		public fetch: (uri: string, config?: any) => Promise<FetchResponse>,
		public systemConfig: GeneratedConfig = { map: {}, meta: {}, packages: {} }
	) {}

	private findStep(guess: PackageLocation, alternatives: PackageLocation[]): Promise<string> {
		const packageRoot = guess.modulesRoot + guess.name;

		const result = this.ifExists(packageRoot + '/package.json').then(
			(uri: string) => packageRoot,
			() => {
				const next = alternatives!.pop();
				if(!next) {
					throw(new Error('Cannot find root of package using Node.js module resolution: ' + guess.name));
				}

				return(this.findStep(next, alternatives));
			}
		);

		return(result);
	}

	findPackage(
		name: string,
		guess: string,
		alternatives: PackageLocation[] = []
	) {
		const lowName = name.toLowerCase();
		const parts = guess.split('/');
		let partCount = parts.length;
		let found = 0;

		while(partCount--) {
			const lowPart = parts[partCount].toLowerCase();
			if(lowPart == 'node_modules') { found = 0; break; }
			if(found) { partCount = found; break; }
			if(lowPart == lowName) found = partCount;
		}

		if(partCount <= 0) partCount = parts.length;

		let dir = parts.slice(0, 2).join('/');

		for(let partNum = 2; partNum < partCount; ++partNum) {
			dir = dir + '/' + parts[partNum];
			alternatives.push({ modulesRoot: dir + '/node_modules/', name});
		}

		if(found) {
			alternatives.push({
				modulesRoot: parts.slice(0, found).join('/') + '/',
				name: parts[found]
			});
		}

		return(this.findStep(alternatives.pop()!, alternatives));
	}

	applyConfig(sys: typeof SystemJS) {
		sys.config(this.pending);

		if(this.port) {
			this.port.postMessage({
				method: METHOD.config,
				config: this.pending
			});
		}

		this.pending = { packages: {} };
	}

	findFile(
		name: string,
		guess: string,
		sys: typeof SystemJS,
	) {
		// Parse imports that start with an npm package name.
		const parts = name.match(/^((@[0-9a-z][-_.0-9a-z]*\/)?[0-9a-z][-_.0-9a-z]*)(\/(.*))?/);
		if(!parts) {
			throw(new Error('Cannot parse missing dependency using Node.js module resolution: ' + name));
		}

		const config = this.systemConfig;
		const packageName = parts[1];
		let pathName = parts[4];
		let rootUri: string;

		const result = this.findPackage(
			packageName,
			guess,
			[{ modulesRoot: 'http://unpkg.com/', name: packageName }]
		).then((resolved: string) => {
			rootUri = resolved;

			return(this.fetch(rootUri + '/package.json', { cache: 'force-cache' }));
		}).then((res: FetchResponse) => {
			rootUri = res.url.replace(/\/package\.json$/i, '');

			const modulesRoot = rootUri.replace(/[^/]*$/, '');
			const modulesGlob = modulesRoot + '*';
			const pending = this.pending;

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

			return(res.text());
		}).then((data: string) => {
			const pending = this.pending;
			const pkg = JSON.parse(data);
			let main = pkg.main || 'index.js';

			this.jsonTbl[packageName] = pkg;
			this.packageTree.insert(rootUri, packageName);

			config.map[packageName] = rootUri;

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

			if(packageName == 'typescript') {
				// Fix incorrect module type autodetection due to comments
				// containing ES6 code.

				if(!subConfig.meta) subConfig.meta = {};
				subConfig.meta['*.js'] = { exports: 'ts', format: 'global' };
			}

			pending.packages[packageName] = subConfig;
			this.applyConfig(sys);

			pathName = pathName || main;

			return((rootUri + '/' + pathName).replace(/(\/[^./]+)$/, '$1.js'));
		});

		return(result);
	}

	systemResolve(
		name: string,
		parentName: string,
		sys: typeof SystemJS,
		originalResolve: typeof SystemJS.resolve
	) {
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

		const result = originalResolve.call(sys, name, parentName).then(findAlternatives).catch(
			// Try to find the dependency using npm-style resolution.
			() => this.findFile(name, uri, sys).then(findAlternatives)
		).then((resolved: string) => {
			const other = resolved == otherUri && this.packageTree.find(otherUri);

			// If the path was a directory containing index.js,
			// add a mapping with the full path to SystemJS config.

			if(other) {
				const packageName = other.node!['/data']!;
				const subPath = '.' + otherUri.substr(other.next!);

				let subConfig = this.systemConfig.packages[packageName];

				if(!subConfig) {
					subConfig = {};
					this.systemConfig.packages[packageName] = subConfig;
				}

				if(!subConfig.map) subConfig.map = {};
				subConfig.map[subPath.replace(/\/index\.js$/, '.js')] = subPath;

				this.pending.packages[packageName] = subConfig;
				this.applyConfig(sys);
			}

			uri = resolved;

			return(originalResolve.call(sys, name, parentName));
		}).then((resolved: string) => {
			// Verify that SystemJS was correctly configured.

			if(resolved != uri) {
				throw(new Error('Misconfiguration: ' + resolved + ' != ' + uri));
			}

			return(resolved);
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
			parentName: string,
		) {
			return(resolver.systemResolve(name, parentName, this, originalResolve));
		};

		return(this);
	}

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

	reportLoad(success: boolean) {
		this.port.postMessage({ method: METHOD.loaded, success });
	}

	private port: MessagePort;
	private existsCache: HandlerCache<string> = {};
	private fetchCache: HandlerCache<FetchResponse> = {};

	private packageTree = new PathTree<string>();
	private pending: SystemConfig = { packages: {} };

	jsonTbl: { [key: string]: Object } = {};

}

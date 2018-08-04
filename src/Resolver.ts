import * as SystemJS from 'systemjs';

import { PathTree } from './PathTree';

export interface PackageLocation {
	modulesRoot: string;
	name: string;
}

export interface SystemConfig {
	map?: { [name: string]: any };
	meta?: { [name: string]: any };
	packages: { [name: string]: any };
};

export interface GeneratedConfig extends SystemConfig {
	map: { [name: string]: any };
	meta: { [name: string]: any };
};

export class Resolver {

	constructor(
		public ifExists: (uri: string) => Promise<any>,
		public fetch: (uri: string) => Promise<{ text(): Promise<string> }>
	) {}

	findPackageStep(guess: PackageLocation, alternatives: PackageLocation[]): Promise<string> {
		const packageRoot = guess.modulesRoot + guess.name;

		const result = this.ifExists(packageRoot + '/package.json').then(
			() => {
				const modulesGlob = guess.modulesRoot + '*';

				if(!this.systemConfig.meta[modulesGlob]) {
					this.systemConfig.meta[modulesGlob] = {
						globals: { process: 'global:process' }
					};

					this.systemConfig.packages[guess.modulesRoot] = {
						defaultExtension: 'js'
					};

					if(!this.systemPending.meta) this.systemPending.meta = {};
					if(!this.systemPending.packages) this.systemPending.packages = {};

					this.systemPending.meta[modulesGlob] = this.systemConfig.meta[modulesGlob];
					this.systemPending.packages[guess.modulesRoot] = this.systemConfig.packages[guess.modulesRoot];
				}

				return(packageRoot);
			},
			() => {
				const next = alternatives!.pop();
				if(!next) throw(new Error());

				return(this.findPackageStep(next, alternatives));
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

		return(this.findPackageStep(alternatives.pop()!, alternatives));
	}

	findFile(
		name: string,
		guess: string,
		sys: typeof SystemJS,
	) {
		// Parse imports that start with an npm package name.
		const parts = name.match(/^((@[0-9a-z][-_.0-9a-z]*\/)?[0-9a-z][-_.0-9a-z]*)(\/(.*))?/);
		if(!parts) throw(new Error());

		const packageName = parts[1];
		let pathName = parts[4];
		let rootUri: string;

		const result = this.findPackage(
			packageName,
			guess,
			[{ modulesRoot: 'http://unpkg.com/', name: packageName }]
		).then((resolved: string) => {
			rootUri = resolved;

			return(this.fetch(rootUri + '/package.json'));
		}).then((res: { url: string, text(): Promise<string> }) => {
			rootUri = res.url.replace(/\/package\.json$/, '');
			return(res.text());
		}).then((data: string) => {
			// console.log(data);
			const pkg = JSON.parse(data);
			let main = pkg.main || 'index.js';

			this.jsonTbl[packageName] = pkg;
			this.packageTree.insert(rootUri, packageName);

			const config = this.systemConfig;
			const pending = this.systemPending;

			config.map[packageName] = rootUri;

			if(!pending.map) pending.map = {}
			pending.map[packageName] = config.map[packageName];

			let subConfig = config.packages[packageName];

			if(!subConfig) {
				subConfig = {};
				config.packages[packageName] = subConfig;
			}

			subConfig.main = main;

			// Use browser entry point if available.
			if(typeof(pkg.browser) == 'string') {
				if(pathName == main) pathName = pkg.browser;
				main = pkg.browser;
			} else if(typeof(pkg.browser) == 'object') {
				if(!subConfig.map) subConfig.map = {};

				for(let key of Object.keys(pkg.browser)) {
					subConfig.map[key] = pkg.browser[key] || '@empty';
				}
			}

			pending.packages[packageName] = subConfig;

			pathName = pathName || main;

			console.log(JSON.stringify(pending, null, '\t'))
			sys.config(pending);
			this.systemPending = { packages: {} };

			return((rootUri + '/' + pathName).replace(/(\/[^./]+)$/, '$1.js'));
		});

		return(result);
	}

	sysResolve(
		name: string,
		parentName: string,
		sys: typeof SystemJS,
		originalResolve: typeof SystemJS.resolve
	) {
		let uri: string;
		let indexUri: string;

		const result = originalResolve.call(sys, name, parentName).then((resolved: string) => {
			uri = resolved;
			indexUri = uri.replace(/(\.js)?$/, '/index.js');

			if(sys.registry.get(uri)) return(uri);
			if(sys.registry.get(indexUri)) return(indexUri);

			return(this.ifExists(uri).catch(() => this.ifExists(indexUri)));
		}).catch(
			() => this.findFile(name, uri, sys).then((found: string) => {
				indexUri = found.replace(/(\.js)?$/, '/index.js');
				return(this.ifExists(found).catch(() => this.ifExists(indexUri)));
			})
		).then((resolved: string) => {
			if(resolved == indexUri) {
				const found = this.packageTree.find(indexUri);

				if(found) {
					const packageName = found.node!['/data']!;
					const subPath = '.' + indexUri.substr(found.next!);

					console.log(subPath);

					let subConfig = this.systemConfig.packages[packageName];

					if(!subConfig) {
						subConfig = {};
						this.systemConfig.packages[packageName] = subConfig;
					}

					if(!subConfig.map) subConfig.map = {};
					subConfig.map[subPath.replace(/\/index\.js$/, '.js')] = subPath;

					this.systemPending.packages[packageName] = subConfig;

					sys.config(this.systemPending);
					this.systemPending = { packages: {} };
				}
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

	patchSystem(system: typeof SystemJS, env = 'production') {
		const originalResolve = system.resolve;
		const resolver = this;

		system.set('global:process', system.newModule({ env: { 'NODE_ENV': env } }));

		system.resolve = function(
			this: typeof SystemJS,
			name: string,
			parentName: string,
		) {
			return(resolver.sysResolve(name, parentName, this, originalResolve));
		};
	}

	systemConfig: GeneratedConfig = { map: {}, meta: {}, packages: {} };
	systemPending: SystemConfig = { packages: {} };
	packageTree = new PathTree<string>();
	jsonTbl: { [key: string]: Object } = {};

}

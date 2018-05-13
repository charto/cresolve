import * as SystemJS from 'systemjs';

export class Resolver {

	constructor(
		public ifExists: (uri: string) => Promise<any>,
		public fetch: (uri: string) => Promise<{ text(): Promise<string> }>
	) {}

	findPackageStep(guess: string, alternatives: string[]): Promise<string> {
		return(this.ifExists(guess + '/package.json').then(() => guess, () => {
			const next = alternatives!.pop();
			if(!next) throw(new Error());

			return(this.findPackageStep(next, alternatives));
		}));
	}

	findPackage(
		name: string,
		guess: string,
		alternatives: string[] = []
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
			alternatives.push(dir + '/node_modules/' + name);
		}

		if(found) alternatives.push(parts.slice(0, found + 1).join('/'));

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
			[ 'http://unpkg.com/' + packageName ]
		).then((resolved: string) => {
			rootUri = resolved;

			return(this.fetch(rootUri + '/package.json'));
		}).then(
			(res: { text(): Promise<string> }) => res.text()
		).then((data: string) => {
			const pkg = JSON.parse(data);
			let main = pkg.main || 'index.js';

			this.metadata[packageName] = pkg;

			// Use browser entry point if available.
			if(typeof(pkg.browser) == 'string') {
				if(pathName == main) pathName = pkg.browser;
				main = pkg.browser;
			}

			pathName = pathName || main;

			if(typeof(pkg.browser) == 'object') {
				// TODO: Parse browser field.
				// Apply mappings to main and pathName.
			}

			// TODO: Configure SystemJS.

			const map: { [name: string]: string } = {};
			const packages: { [name: string]: any } = {};
			const packageSpec: any = {
				main
			};

			//packageSpec.map = {};

			map[packageName] = rootUri;
			packages[packageName] = packageSpec;

			sys.config({ map, packages });
			console.log(sys.getConfig())

			return(rootUri + '/' + pathName);
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

			return(this.ifExists(uri).then(() => uri));
		}).catch(
			() => this.ifExists(indexUri).then(() => indexUri)
		).catch(
			() => this.findFile(name, uri, sys)
		).then((resolved: string) => {
			if(resolved == indexUri) {
				// TODO: Configure path mapping in SystemJS.
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

	patchSystem(system: typeof SystemJS) {
		const originalResolve = system.resolve;
		const resolver = this;

		system.resolve = function(
			this: typeof SystemJS,
			name: string,
			parentName: string,
		) {
			return(resolver.sysResolve(name, parentName, this, originalResolve));
		};
	}

	metadata: { [key: string]: Object } = {};

}

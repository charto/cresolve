import * as FS from 'fs';
import * as Path from 'path';
import * as SystemType from 'systemjs';
import { Resolver } from '../dist/Resolver';
import { isNode, ifExists, fetch as fetcher } from '../dist/fetch';

declare var SystemJS: typeof SystemType;
var System: typeof SystemType = typeof(SystemJS) == 'object' ? SystemJS : null as any;

const fetch = fetcher;

if(isNode) {
	const fs: typeof FS = eval("require('fs')");
	const path: typeof Path = eval("require('path')");

	eval(fs.readFileSync(require.resolve('systemjs'), 'utf-8'));
	eval(
		"var SystemJS = System = module.exports;" +
		fs.readFileSync(path.resolve(__dirname, '../config.js'), 'utf-8')
	);
}

const system = new System.constructor();

new Resolver(ifExists, fetch).patchSystem(system);

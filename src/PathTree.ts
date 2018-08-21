export class TreeBranch<Type> {

	constructor(name?: string, parent?: TreeBranch<Type>) {
		this['/name'] = name;
		this['..'] = parent;
		this['.'] = this;
	}

	[ name: string ]: TreeBranch<Type> | string | Type | undefined;

	'/name'?: string;
	'/data'?: Type;
	'.': this;

}

export class PathTree<Type> {

	insert(path: string, data?: Type) {
		let node = this.root;

		for(let part of path.split('/')) {
			if(!node[part]) node[part] = new TreeBranch(part, node);
			node = node[part] as TreeBranch<Type>;
		}

		node['/data'] = node['/data'] || data;
		return(node);
	}

	find(path: string, result: { node?: TreeBranch<Type>, next?: number } = {}) {
		let node: TreeBranch<Type> | undefined = this.root;
		let pos = 0;

		while(1) {
			const next = path.indexOf('/', pos);
			if(next < 0) break;

			node = node[path.substr(pos, next - pos)] as TreeBranch<Type> | undefined;
			if(!node) break;

			if(node['/data']) {
				result.node = node;
				result.next = next;

				return(result);
			}

			pos = next + 1;
		}
	}

	root = new TreeBranch<Type>();

}

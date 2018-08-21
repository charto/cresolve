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

	find(path: string, output: { node?: TreeBranch<Type>, next?: number } = {}) {
		let node: TreeBranch<Type> | undefined = this.root;
		let result: typeof output | undefined;
		let next: number;
		let pos = 0;

		while(
			(next = path.indexOf('/', pos)) >= 0 &&
			(node = node[path.substr(pos, next - pos)] as TreeBranch<Type> | undefined)
		) {
			if(node['/data']) {
				result = output;
				result.node = node;
				result.next = next;
			}

			pos = next + 1;
		}

		return(result);
	}

	root = new TreeBranch<Type>();

}

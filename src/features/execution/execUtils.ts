export function quoteStringIfNecessary(arg: string): string {
    if (arg.indexOf(' ') >= 0 && !(arg.startsWith('"') && arg.endsWith('"'))) {
        return `"${arg}"`;
    }
    return arg;
}

export function quoteArgs(args: string[]): string[] {
    return args.map(quoteStringIfNecessary);
}

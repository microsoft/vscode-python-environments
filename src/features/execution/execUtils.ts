export function quoteStringIfNecessary(arg: string): string {
    // Always return if already quoted to avoid double-quoting
    if (arg.startsWith('"') && arg.endsWith('"')) {
        return arg;
    }

    // Quote if contains common shell special characters that are problematic across multiple shells
    // Includes: space, &, |, <, >, ;, ', ", `, (, ), [, ], {, }, $
    const needsQuoting = /[\s&|<>;'"`()\[\]{}$]/.test(arg);

    return needsQuoting ? `"${arg}"` : arg;
}

export function quoteArgs(args: string[]): string[] {
    return args.map(quoteStringIfNecessary);
}

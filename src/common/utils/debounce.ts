export interface SimpleDebounce {
    trigger(): void;
}

class SimpleDebounceImpl {
    private timeout: NodeJS.Timeout | undefined;

    constructor(private readonly ms: number, private readonly callback: () => void) {}

    public trigger() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            this.callback();
        }, this.ms);
    }
}

export function createSimpleDebounce(ms: number, callback: () => void): SimpleDebounce {
    return new SimpleDebounceImpl(ms, callback);
}

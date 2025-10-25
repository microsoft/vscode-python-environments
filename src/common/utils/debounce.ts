import { Disposable } from 'vscode';

export interface SimpleDebounce extends Disposable {
    trigger(): void;
}

class SimpleDebounceImpl extends Disposable {
    private timeout: NodeJS.Timeout | undefined;

    constructor(private readonly ms: number, private readonly callback: () => void) {
        super(() => {
            if (this.timeout) {
                clearTimeout(this.timeout);
                this.timeout = undefined;
            }
        });
    }

    public trigger() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            this.callback();
        }, this.ms);
    }

    public dispose() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
    }
}

export function createSimpleDebounce(ms: number, callback: () => void): SimpleDebounce {
    return new SimpleDebounceImpl(ms, callback);
}

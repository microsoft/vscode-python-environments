import {
    CancellationToken,
    Disposable,
    Event,
    EventEmitter,
    FileDecoration,
    FileDecorationProvider,
    ThemeColor,
    Uri,
} from 'vscode';
import { registerFileDecorationProvider } from '../../common/window.apis';
import { SelectedDecoratorStrings } from '../../common/localize';
import { PythonProjectEnvironmentApi } from '../../api';

class SelectedEnvDecorationProvider implements FileDecorationProvider, Disposable {
    private readonly onDidChangeFileDecorationsEmitter = new EventEmitter<Uri | Uri[] | undefined>();
    private readonly disposables: Disposable[] = [];
    private readonly selected: Set<string> = new Set();
    constructor(private em: PythonProjectEnvironmentApi) {
        this.disposables.push(
            this.em.onDidChangeEnvironment((e) => {
                const uris = [];
                if (e.old) {
                    this.selected.delete(e.old.environmentPath.toString());
                    uris.push(e.old.environmentPath);
                }
                if (e.new) {
                    this.selected.add(e.new.environmentPath.toString());
                    uris.push(e.new.environmentPath);
                }
                this.onDidChangeFileDecorationsEmitter.fire(uris);
            }),
            this.onDidChangeFileDecorationsEmitter,
        );
    }

    onDidChangeFileDecorations?: Event<Uri | Uri[] | undefined> | undefined =
        this.onDidChangeFileDecorationsEmitter.event;

    async provideFileDecoration(uri: Uri, _token: CancellationToken): Promise<FileDecoration | undefined> {
        if (!this.selected.has(uri.toString())) {
            return undefined;
        }
        return {
            badge: 'S',
            color: new ThemeColor('testing.iconPassed'),
            tooltip: SelectedDecoratorStrings.selectedToolTip,
        };
    }

    dispose() {}
}

export function registerSelectedDecorator(em: PythonProjectEnvironmentApi): Disposable {
    return registerFileDecorationProvider(new SelectedEnvDecorationProvider(em));
}

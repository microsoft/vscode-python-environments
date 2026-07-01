import { Package } from '../api';
import { PackageManagerCommandArguments } from './PackageManagerCommandArguments';

export namespace PackageManagerCommand {
    export interface Version {
        execute(): Promise<string>;
    }

    export interface Install {
        execute(options: PackageManagerCommandArguments.Install): Promise<Package[]>;
    }

    export interface Uninstall {
        execute(options: PackageManagerCommandArguments.Uninstall): Promise<Package[]>;
    }

    export interface List {
        execute(options: PackageManagerCommandArguments.List): Promise<Package[]>;
    }

    export interface AvailableVersions {
        execute(packageName: string, options: PackageManagerCommandArguments.AvailableVersions): Promise<string[]>;
    }
}

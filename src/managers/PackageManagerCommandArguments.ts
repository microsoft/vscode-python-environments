export namespace PackageManagerCommandArguments {
    export interface Install {
        packages: { packageName: string; version?: string }[];
    }

    export interface Uninstall {
        packages: { packageName: string; version?: string }[];
    }

    export interface List {
        directOnly?: boolean;
    }

    export interface AvailableVersions {
        includePrerelease?: boolean;
    }
}

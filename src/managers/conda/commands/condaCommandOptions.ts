import { CommandConstructorOptions } from '../../base/commands/index';

export interface CondaCommandConstructorOptions extends CommandConstructorOptions {
    condaEnvironmentPath: string;
}

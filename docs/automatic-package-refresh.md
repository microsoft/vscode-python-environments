# Automatic Package List Refresh

This feature automatically refreshes the package list when packages are installed or uninstalled in Python environments. It works by monitoring each environment's package directory for changes and triggering the package manager's refresh functionality when changes are detected.

## How It Works

1. **Environment Setup**: Each environment specifies its package directory via the `packageFolder` property
2. **Environment Monitoring**: The `SitePackagesWatcherService` listens for environment changes (add/remove)
3. **File System Watching**: Creates VS Code file system watchers to monitor the package directories
4. **Automatic Refresh**: When changes are detected, triggers the appropriate package manager's `refresh()` method

## Supported Environment Types

The feature works with all environment types that set the `packageFolder` property:

- **venv** environments
- **conda** environments  
- **system** Python installations
- **poetry** environments
- **pyenv** environments

## Package Directory Resolution

Each environment manager is responsible for setting the `packageFolder` property when creating environments. The resolution follows platform-specific patterns:

### Windows
- `{sysPrefix}/Lib/site-packages`

### Unix/Linux/macOS
- `{sysPrefix}/lib/python3/site-packages` (standard environments)
- `{sysPrefix}/site-packages` (conda-style environments)

### Environment Manager Implementation

Environment managers use the `resolvePackageFolderFromSysPrefix()` utility function to determine the appropriate package directory based on the environment's `sysPrefix`.

## Implementation Details

### Key Components

1. **`SitePackagesWatcherService`**: Main service that manages file system watchers
2. **`sitePackagesUtils.ts`**: Utility function for resolving package folder paths from sysPrefix
3. **Environment Managers**: Each manager sets the `packageFolder` property when creating environments
4. **Integration**: Automatically initialized in `extension.ts` when the extension activates

### Lifecycle Management

- **Initialization**: Watchers are created for existing environments when the service starts
- **Environment Changes**: New watchers are added when environments are created, removed when environments are deleted
- **Cleanup**: All watchers are properly disposed when the extension deactivates

### Error Handling

- Graceful handling of environments without a `packageFolder` property
- Robust error handling for file system operations
- Fallback behavior when package directories cannot be accessed

## Benefits

1. **Real-time Updates**: Package lists are automatically updated when packages change
2. **Cross-platform Support**: Works on Windows, macOS, and Linux
3. **Environment Agnostic**: Supports all Python environment types
4. **Performance**: Uses VS Code's efficient file system watchers
5. **User Experience**: No manual refresh needed after installing/uninstalling packages
6. **Simplified Architecture**: Environment managers explicitly specify their package directories

## Technical Notes

- File system events are debounced to avoid excessive refresh calls
- Package refreshes happen asynchronously to avoid blocking the UI
- The service integrates seamlessly with existing package manager architecture
- Environment managers use the `resolvePackageFolderFromSysPrefix()` utility for consistent package directory resolution
- Comprehensive test coverage ensures reliability across different scenarios

## For Environment Manager Developers

When implementing a new environment manager, ensure you set the `packageFolder` property in your `PythonEnvironmentInfo`:

```typescript
import { resolvePackageFolderFromSysPrefix } from '../../features/packageWatcher';

const environmentInfo: PythonEnvironmentInfo = {
    // ... other properties
    sysPrefix: '/path/to/environment',
    packageFolder: resolvePackageFolderFromSysPrefix('/path/to/environment'),
    // ... other properties
};
```

This ensures automatic package refresh functionality works with your environment type.
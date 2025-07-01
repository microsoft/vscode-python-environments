# Automatic Package List Refresh

This feature automatically refreshes the package list when packages are installed or uninstalled in Python environments. It works by monitoring the `site-packages` directory for changes and triggering the package manager's refresh functionality when changes are detected.

## How It Works

1. **Environment Monitoring**: The `SitePackagesWatcherService` listens for environment changes (add/remove)
2. **Site-packages Resolution**: For each environment, the service resolves the site-packages path using the environment's `sysPrefix`
3. **File System Watching**: Creates VS Code file system watchers to monitor the site-packages directories
4. **Automatic Refresh**: When changes are detected, triggers the appropriate package manager's `refresh()` method

## Supported Environment Types

The feature works with all environment types that provide a valid `sysPrefix`:

- **venv** environments
- **conda** environments  
- **system** Python installations
- **poetry** environments
- **pyenv** environments

## Site-packages Path Resolution

The service automatically detects site-packages directories on different platforms:

### Windows
- `{sysPrefix}/Lib/site-packages`

### Unix/Linux/macOS
- `{sysPrefix}/lib/python3.*/site-packages`
- `{sysPrefix}/lib/python3/site-packages` (fallback)

### Conda Environments
- `{sysPrefix}/site-packages` (for minimal environments)

## Implementation Details

### Key Components

1. **`SitePackagesWatcherService`**: Main service that manages file system watchers
2. **`sitePackagesUtils.ts`**: Utility functions for resolving site-packages paths
3. **Integration**: Automatically initialized in `extension.ts` when the extension activates

### Lifecycle Management

- **Initialization**: Watchers are created for existing environments when the service starts
- **Environment Changes**: New watchers are added when environments are created, removed when environments are deleted
- **Cleanup**: All watchers are properly disposed when the extension deactivates

### Error Handling

- Graceful handling of environments without valid `sysPrefix`
- Robust error handling for file system operations
- Fallback behavior when site-packages directories cannot be found

## Benefits

1. **Real-time Updates**: Package lists are automatically updated when packages change
2. **Cross-platform Support**: Works on Windows, macOS, and Linux
3. **Environment Agnostic**: Supports all Python environment types
4. **Performance**: Uses VS Code's efficient file system watchers
5. **User Experience**: No manual refresh needed after installing/uninstalling packages

## Technical Notes

- File system events are debounced to avoid excessive refresh calls
- Package refreshes happen asynchronously to avoid blocking the UI
- The service integrates seamlessly with existing package manager architecture
- Comprehensive test coverage ensures reliability across different scenarios
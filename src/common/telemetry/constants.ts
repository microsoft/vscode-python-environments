export enum EventNames {
    EXTENSION_ACTIVATION_DURATION = 'EXTENSION.ACTIVATION_DURATION',
    EXTENSION_MANAGER_REGISTRATION_DURATION = 'EXTENSION.MANAGER_REGISTRATION_DURATION',

    ENVIRONMENT_MANAGER_REGISTERED = 'ENVIRONMENT_MANAGER.REGISTERED',
    PACKAGE_MANAGER_REGISTERED = 'PACKAGE_MANAGER.REGISTERED',
    ENVIRONMENT_MANAGER_SELECTED = 'ENVIRONMENT_MANAGER.SELECTED',
    PACKAGE_MANAGER_SELECTED = 'PACKAGE_MANAGER.SELECTED',

    VENV_USING_UV = 'VENV.USING_UV',
    VENV_CREATION = 'VENV.CREATION',

    UV_PYTHON_INSTALL_PROMPTED = 'UV.PYTHON_INSTALL_PROMPTED',
    UV_PYTHON_INSTALL_STARTED = 'UV.PYTHON_INSTALL_STARTED',
    UV_PYTHON_INSTALL_COMPLETED = 'UV.PYTHON_INSTALL_COMPLETED',
    UV_PYTHON_INSTALL_FAILED = 'UV.PYTHON_INSTALL_FAILED',

    PACKAGE_MANAGEMENT = 'PACKAGE_MANAGEMENT',
    ADD_PROJECT = 'ADD_PROJECT',
    /**
     * Telemetry event for when a Python environment is created via command.
     * Properties:
     * - manager: string (the id of the environment manager used, or 'none')
     * - triggeredLocation: string (where the create command is called from)
     */
    CREATE_ENVIRONMENT = 'CREATE_ENVIRONMENT',
    /**
     * Telemetry event for project structure metrics at extension startup.
     * Properties:
     * - totalProjectCount: number (total number of projects)
     * - uniqueInterpreterCount: number (count of distinct interpreter paths)
     * - projectUnderRoot: number (count of projects nested under workspace roots)
     */
    PROJECT_STRUCTURE = 'PROJECT_STRUCTURE',
    /**
     * Telemetry event for environment tool usage at extension startup.
     * Fires once per tool that has at least one project using it.
     * Use dcount(machineId) by toolName to get unique users per tool.
     * Properties:
     * - toolName: string (the tool being used: venv, conda, poetry, etc.)
     */
    ENVIRONMENT_TOOL_USAGE = 'ENVIRONMENT_TOOL_USAGE',
    /**
     * Telemetry event for environment discovery per manager.
     * Properties:
     * - managerId: string (the id of the environment manager)
     * - result: 'success' | 'error' | 'timeout'
     * - envCount: number (environments found, on success only)
     * - errorType: string (error class name, on failure only)
     */
    ENVIRONMENT_DISCOVERY = 'ENVIRONMENT_DISCOVERY',
    MANAGER_READY_TIMEOUT = 'MANAGER_READY.TIMEOUT',
    /**
     * Telemetry event for individual manager registration failure.
     * Fires once per manager that fails during registration (inside safeRegister).
     * Properties:
     * - managerName: string (e.g. 'system', 'conda', 'pyenv', 'pipenv', 'poetry', 'shellStartupVars')
     * - errorType: string (classified error category from classifyError)
     * - failureStage: string (hierarchical stage indicator, e.g. 'getPipenv:nativeFinderRefresh')
     */
    MANAGER_REGISTRATION_FAILED = 'MANAGER_REGISTRATION.FAILED',
    /**
     * Telemetry event fired when the setup block appears to be hung.
     * A watchdog timer fires after a deadline; if the setup completes normally,
     * the timer is cancelled and this event never fires.
     * Properties:
     * - failureStage: string (which phase was in progress when the watchdog fired)
     */
    SETUP_HANG_DETECTED = 'SETUP.HANG_DETECTED',
    /**
     * Telemetry event for when a manager skips registration because its tool was not found.
     * This is an expected outcome (not an error) and is distinct from MANAGER_REGISTRATION_FAILED.
     * Properties:
     * - managerName: string (e.g. 'conda', 'pyenv', 'pipenv', 'poetry')
     * - reason: string ('tool_not_found')
     */
    MANAGER_REGISTRATION_SKIPPED = 'MANAGER_REGISTRATION.SKIPPED',
    /**
     * Telemetry event for PET (Python Environment Tools) initialization timing.
     * Tracks how long it takes to create and start the native Python finder.
     * Properties:
     * - result: 'success' | 'error' | 'timeout'
     * - errorType: string (classified error category, on failure only)
     */
    PET_INIT_DURATION = 'PET.INIT_DURATION',
    /**
     * Telemetry event fired when applyInitialEnvironmentSelection begins.
     * Signals that all managers are registered and env selection is starting.
     * Properties:
     * - registeredManagerCount: number (how many env managers registered)
     * - workspaceFolderCount: number (how many workspace folders to process)
     */
    ENV_SELECTION_STARTED = 'ENV_SELECTION.STARTED',
    /**
     * Telemetry event fired per scope when the priority chain resolves.
     * Properties:
     * - scope: string ('workspace' or 'global')
     * - prioritySource: string (which priority won: 'pythonProjects', 'defaultEnvManager', 'defaultInterpreterPath', 'autoDiscovery')
     * - managerId: string (the winning manager's id)
     * - resolutionPath: string ('envPreResolved' = env already resolved, 'managerDiscovery' = needed full discovery)
     * - hasPersistedSelection: boolean (whether a persisted env path existed in workspace state)
     */
    ENV_SELECTION_RESULT = 'ENV_SELECTION.RESULT',
    /**
     * Telemetry event fired when applyInitialEnvironmentSelection returns.
     * Duration measures the blocking time (excludes deferred global scope).
     * Properties:
     * - globalScopeDeferred: boolean (true = global scope fired in background, false = awaited)
     * Measures (sent in the `measures` arg because of `isMeasurement: true` in GDPR):
     * - duration: number (ms)
     * - workspaceFolderCount: number (total workspace folders)
     * - resolvedFolderCount: number (folders that resolved with a non-undefined env)
     * - settingErrorCount: number (user-configured settings that could not be applied)
     */
    ENV_SELECTION_COMPLETED = 'ENV_SELECTION.COMPLETED',
    /**
     * Telemetry event fired when a lazily-registered manager completes its first initialization.
     * Replaces MANAGER_REGISTRATION_SKIPPED and MANAGER_REGISTRATION_FAILED for managers
     * that now register unconditionally (pipenv, poetry, pyenv).
     * Properties:
     * - managerName: string (e.g. 'pipenv', 'poetry', 'pyenv')
     * - result: 'success' | 'tool_not_found' | 'error'
     * - envCount: number (environments discovered)
     * - toolSource: string (how the CLI was found: 'settings', 'local', 'pet', 'none')
     * - errorType: string (classified error category, on failure only)
     */
    MANAGER_LAZY_INIT = 'MANAGER.LAZY_INIT',
    /**
     * Telemetry event fired when the JSON CLI fallback is used for environment discovery.
     * Triggered when the PET JSON-RPC server mode is exhausted after all restart attempts.
     * Properties:
     * - operation: 'refresh' | 'resolve'
     * - result: 'success' | 'error'
     * - duration: number (milliseconds taken for the CLI operation)
     */
    PET_JSON_CLI_FALLBACK = 'PET.JSON_CLI_FALLBACK',
    /**
     * Telemetry event for a PET refresh attempt (the core discovery RPC call).
     * Properties:
     * - result: 'success' | 'timeout' | 'error'
     * - envCount: number (environments returned via notifications)
     * - unresolvedCount: number (envs that needed follow-up resolve calls)
     * - workspaceDirCount: number (workspace directories sent in configure)
     * - searchPathCount: number (extra search paths sent in configure)
     * - attempt: number (0 = first try, 1 = retry)
     * - errorType: string (classified error category, on failure only)
     */
    PET_REFRESH = 'PET.REFRESH',
    /**
     * Telemetry event for a PET configure RPC call.
     * Properties:
     * - result: 'success' | 'timeout' | 'error' | 'skipped'
     * - workspaceDirCount: number
     * - envDirCount: number (environmentDirectories count)
     * - retryCount: number (consecutive timeout count from ConfigureRetryState)
     */
    PET_CONFIGURE = 'PET.CONFIGURE',
    /**
     * Telemetry event for PET process restart attempts.
     * Properties:
     * - attempt: number (1-based restart attempt number)
     * - result: 'success' | 'error'
     * - errorType: string (classified error category, on failure only)
     */
    PET_PROCESS_RESTART = 'PET.PROCESS_RESTART',
    /**
     * Telemetry event for PET resolve calls (single-env resolution).
     * Properties:
     * - result: 'success' | 'timeout' | 'error'
     * - errorType: string (classified error category, on failure only)
     */
    PET_RESOLVE = 'PET.RESOLVE',
}

// Map all events to their properties
export interface IEventNamePropertyMapping {
    /* __GDPR__
       "extension.activation_duration": {
           "duration" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
       }
    */
    [EventNames.EXTENSION_ACTIVATION_DURATION]: never | undefined;
    /* __GDPR__
       "extension.manager_registration_duration": {
           "duration" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
           "result" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
           "failureStage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
           "errorType" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" }
       }
    */
    [EventNames.EXTENSION_MANAGER_REGISTRATION_DURATION]: {
        result: 'success' | 'error';
        failureStage?: string;
        errorType?: string;
    };

    /* __GDPR__
        "environment_manager.registered": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ENVIRONMENT_MANAGER_REGISTERED]: {
        managerId: string;
    };

    /* __GDPR__
        "package_manager.registered": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PACKAGE_MANAGER_REGISTERED]: {
        managerId: string;
    };

    /* __GDPR__
        "environment_manager.selected": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ENVIRONMENT_MANAGER_SELECTED]: {
        managerId: string;
    };

    /* __GDPR__
        "package_manager.selected": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PACKAGE_MANAGER_SELECTED]: {
        managerId: string;
    };

    /* __GDPR__
        "venv.using_uv": {"owner": "eleanorjboyd" }
    */
    [EventNames.VENV_USING_UV]: never | undefined;

    /* __GDPR__
        "venv.creation": {
            "creationType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.VENV_CREATION]: {
        creationType: 'quick' | 'custom';
    };

    /* __GDPR__
        "uv.python_install_prompted": {
            "trigger": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
        }
    */
    [EventNames.UV_PYTHON_INSTALL_PROMPTED]: {
        trigger: 'activation' | 'createEnvironment';
    };

    /* __GDPR__
        "uv.python_install_started": {
            "uvAlreadyInstalled": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
        }
    */
    [EventNames.UV_PYTHON_INSTALL_STARTED]: {
        uvAlreadyInstalled: boolean;
    };

    /* __GDPR__
        "uv.python_install_completed": {"owner": "karthiknadig" }
    */
    [EventNames.UV_PYTHON_INSTALL_COMPLETED]: never | undefined;

    /* __GDPR__
        "uv.python_install_failed": {
            "stage": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
        }
    */
    [EventNames.UV_PYTHON_INSTALL_FAILED]: {
        stage: 'uvInstall' | 'uvNotOnPath' | 'pythonInstall' | 'findPath';
    };

    /* __GDPR__
        "package_management": {
            "managerId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "triggerSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PACKAGE_MANAGEMENT]: {
        managerId: string;
        result: 'success' | 'error' | 'cancelled';
        errorType?: string;
        triggerSource: 'ui' | 'requirements' | 'package' | 'uninstall';
    };

    /* __GDPR__
        "add_project": {
            "template": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "quickCreate": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "totalProjectCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "triggeredLocation": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ADD_PROJECT]: {
        template: string;
        quickCreate: boolean;
        totalProjectCount: number;
        triggeredLocation: 'templateCreate' | 'add' | 'addGivenResource';
    };

    /* __GDPR__
        "create_environment": {
            "manager": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "triggeredLocation": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.CREATE_ENVIRONMENT]: {
        manager: string;
        triggeredLocation: string;
    };

    /* __GDPR__
        "project_structure": {
            "totalProjectCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "uniqueInterpreterCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "projectUnderRoot": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PROJECT_STRUCTURE]: {
        totalProjectCount: number;
        uniqueInterpreterCount: number;
        projectUnderRoot: number;
    };

    /* __GDPR__
        "environment_tool_usage": {
            "toolName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "stellaHuang95" }
        }
    */
    [EventNames.ENVIRONMENT_TOOL_USAGE]: {
        toolName: string;
    };
    /* __GDPR__
        "environment_discovery": {
            "managerId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "envCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ENVIRONMENT_DISCOVERY]: {
        managerId: string;
        result: 'success' | 'error' | 'timeout';
        envCount?: number;
        errorType?: string;
    };

    /* __GDPR__
        "manager_ready.timeout": {
            "managerId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "managerKind": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.MANAGER_READY_TIMEOUT]: {
        managerId: string;
        managerKind: 'environment' | 'package';
    };

    /* __GDPR__
        "manager_registration.failed": {
            "managerName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
            "failureStage": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" }
        }
    */
    [EventNames.MANAGER_REGISTRATION_FAILED]: {
        managerName: string;
        errorType: string;
        failureStage: string;
    };

    /* __GDPR__
        "setup.hang_detected": {
            "failureStage": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "StellaHuang95" }
        }
    */
    [EventNames.SETUP_HANG_DETECTED]: {
        failureStage: string;
    };

    /* __GDPR__
        "manager_registration.skipped": {
            "managerName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
            "reason": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" }
        }
    */
    [EventNames.MANAGER_REGISTRATION_SKIPPED]: {
        managerName: string;
        reason: 'tool_not_found';
    };

    /* __GDPR__
        "pet.init_duration": {
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PET_INIT_DURATION]: {
        result: 'success' | 'error' | 'timeout';
        errorType?: string;
    };

    /* __GDPR__
        "env_selection.started": {
            "registeredManagerCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "registeredManagerIds": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "workspaceFolderCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ENV_SELECTION_STARTED]: {
        registeredManagerCount: number;
        registeredManagerIds: string;
        workspaceFolderCount: number;
    };

    /* __GDPR__
        "env_selection.result": {
            "scope": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "prioritySource": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "managerId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "resolutionPath": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "hasPersistedSelection": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ENV_SELECTION_RESULT]: {
        scope: string;
        prioritySource: string;
        managerId: string;
        resolutionPath: string;
        hasPersistedSelection: boolean;
    };

    /* __GDPR__
        "env_selection.completed": {
            "globalScopeDeferred": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "workspaceFolderCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "resolvedFolderCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "settingErrorCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.ENV_SELECTION_COMPLETED]: {
        globalScopeDeferred: boolean;
    };

    /* __GDPR__
        "manager.lazy_init": {
            "managerName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "envCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "toolSource": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.MANAGER_LAZY_INIT]: {
        managerName: string;
        result: 'success' | 'tool_not_found' | 'error';
        envCount: number;
        toolSource: string;
        errorType?: string;
    };

    /* __GDPR__
        "pet.json_cli_fallback": {
            "operation": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "StellaHuang95" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "StellaHuang95" }
        }
    */
    [EventNames.PET_JSON_CLI_FALLBACK]: {
        operation: 'refresh' | 'resolve';
        result: 'success' | 'error';
    };

    /* __GDPR__
        "pet.refresh": {
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "envCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "unresolvedCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "workspaceDirCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "searchPathCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "attempt": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PET_REFRESH]: {
        result: 'success' | 'timeout' | 'error';
        envCount?: number;
        unresolvedCount?: number;
        workspaceDirCount?: number;
        searchPathCount?: number;
        attempt: number;
        errorType?: string;
    };

    /* __GDPR__
        "pet.configure": {
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "workspaceDirCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "envDirCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "retryCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PET_CONFIGURE]: {
        result: 'success' | 'timeout' | 'error' | 'skipped';
        workspaceDirCount?: number;
        envDirCount?: number;
        retryCount: number;
    };

    /* __GDPR__
        "pet.process_restart": {
            "attempt": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" },
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PET_PROCESS_RESTART]: {
        attempt: number;
        result: 'success' | 'error';
        errorType?: string;
    };

    /* __GDPR__
        "pet.resolve": {
            "result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "errorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" },
            "<duration>": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "owner": "eleanorjboyd" }
        }
    */
    [EventNames.PET_RESOLVE]: {
        result: 'success' | 'timeout' | 'error';
        errorType?: string;
    };
}

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
           "duration" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
       }
    */
    [EventNames.EXTENSION_MANAGER_REGISTRATION_DURATION]: never | undefined;

    /* __GDPR__
        "environment_manager.registered": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "eleanorjboyd" }
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
        environment_discovery: {
            managerId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; owner: 'eleanorjboyd' };
            result: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; owner: 'eleanorjboyd' };
            envCount: {
                classification: 'SystemMetaData';
                purpose: 'FeatureInsight';
                isMeasurement: true;
                owner: 'eleanorjboyd';
            };
            errorType: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; owner: 'eleanorjboyd' };
            '<duration>': {
                classification: 'SystemMetaData';
                purpose: 'FeatureInsight';
                isMeasurement: true;
                owner: 'eleanorjboyd';
            };
        };
    };
    [EventNames.ENVIRONMENT_DISCOVERY]: {
        managerId: string;
        result: 'success' | 'error' | 'timeout';
        envCount?: number;
        errorType?: string;
    };
}

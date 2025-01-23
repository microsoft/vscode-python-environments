export enum EventNames {
    EXTENSION_ACTIVATION_DURATION = "EXTENSION.ACTIVATION_DURATION",
    EXTENSION_MANAGER_REGISTRATION_DURATION = "EXTENSION.MANAGER_REGISTRATION_DURATION",

    ENVIRONMENT_MANAGER_REGISTERED = "ENVIRONMENT_MANAGER.REGISTERED",
    PACKAGE_MANAGER_REGISTERED = "PACKAGE_MANAGER.REGISTERED",

    VENV_USING_UV = "VENV.USING_UV",
}

// Map all events to their properties
export interface IEventNamePropertyMapping {
    /* __GDPR__
       "extension_activation_duration": {
           "duration" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
       }
    */
    [EventNames.EXTENSION_ACTIVATION_DURATION]: never | undefined;
    /* __GDPR__
       "extension_manager_registration_duration": {
           "duration" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
       }
    */
    [EventNames.EXTENSION_MANAGER_REGISTRATION_DURATION]: never | undefined;

    /* __GDPR__
        "environment_manager_registered": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
        }
    */
    [EventNames.ENVIRONMENT_MANAGER_REGISTERED]: {
        managerId: string;
    };

    /* __GDPR__
        "package_manager_registered": {
            "managerId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "owner": "karthiknadig" }
        }
    */
    [EventNames.PACKAGE_MANAGER_REGISTERED]: {
        managerId: string;
    };

    /* __GDPR__
        "venv_using_uv": {"owner": "karthiknadig" }
    */
    [EventNames.VENV_USING_UV]: never | undefined;
}

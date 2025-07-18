import { BasePromptElementProps, PromptElement, PromptSizing, UserMessage } from '@vscode/prompt-tsx';
import { ChatEnvironmentErrorInfo, ERROR_CHAT_CONTEXT_QUEUE } from './send_prompt';
import { traceWarn } from '../../common/logging';

export interface PythonEnvsPromptProps extends BasePromptElementProps {
    title: string;
    description?: string;
    request: {
        prompt: string;
    };
    response?: {
        content: string;
        error?: string;
    };

}

export class PythonEnvsPrompt extends PromptElement<PythonEnvsPromptProps, void> {
	render(_state: void, _sizing: PromptSizing) {
        traceWarn('Render function called'); // Log when render is invoked

        // this.props is PythonEnvsPromptProps
        const isContext = !ERROR_CHAT_CONTEXT_QUEUE.isEmpty();
        traceWarn('Context queue is empty:', !isContext); // Log the state of the context queue

        if (!isContext) {
            traceWarn('No context found for python helper chat participant');
            return;
        }

        const contextErr: ChatEnvironmentErrorInfo | undefined = ERROR_CHAT_CONTEXT_QUEUE.pop();
        traceWarn('Popped context error:', contextErr); // Log the popped context error

        if (!contextErr) {
            traceWarn('No context error found for python helper chat participant');
            return;
        }

        const attemptedPackages = contextErr.attemptedPackages.join(', ');
        const packagesBeforeInstall = contextErr.packagesBeforeInstall.join(', ');
        traceWarn('Attempted packages:', attemptedPackages); // Log attempted packages
        traceWarn('Packages before install:', packagesBeforeInstall); // Log packages before install

        const envString = contextErr.environment.displayName + ' (' + contextErr.environment.environmentPath + ') ' + contextErr.environment.version;
        traceWarn('Environment string:', envString); // Log environment string

        const rawPrompt = this.props.request.prompt .replace(/^@pythonHelper\s*/, '');
        traceWarn('Raw prompt:', rawPrompt); // Log the raw prompt

        // let errorInfo: ChatEnvironmentErrorInfo | undefined;
        // try {
        //     errorInfo = JSON.stringify(rawPrompt);
        //     traceWarn('Parsed error info:', errorInfo); // Log parsed error info
        // } catch (e) {
        //     console.error('Error parsing raw prompt the prompt:', rawPrompt);
        //     traceWarn('Error parsing raw prompt:', e); // Log parsing error
        // }
        const msg =  <>
                <UserMessage priority={100}>🚨 **Package Management Error**##<br /> ❗ Error Details<br />``` <br /> {contextErr.errorMessage}<br />```<br />Stack Trace<br />```<br />{contextErr.stackTrace}<br />```<br />## 📝 **Context**<br />**Attempted Packages:**{attemptedPackages}<br /><br /> **Package Manager:** {contextErr.packageManager}<br /> **Environment:** {envString}<br /> **Packages Before Install:** {packagesBeforeInstall}<br />## 🛠️ **How to Diagnose & Fix**<br />1. **Diagnose the error above.**<br />2. **Suggest a fix.**<br />3. Use the following tools where applicable:<br />- `installPythonPackage`: Install a package with a version specification, etc.<br />   -`configurePythonEnvironment`: Create an environment with the given attributes.<br /> If you see one best path forward, start doing that WITHOUT asking the user again. If you see 2 to 3 paths to solve this problem, reply with the two paths like so: `button1: prompt solution` `button2: prompt solution</UserMessage>
            </>

        traceWarn('Returning message final:', msg); // Log the final message to be returned
        return msg;

        //  <UserMessage priority={69}><br /> **Attempted Packages:**{attemptedPackages}<br /> **Package Manager:** {contextErr.packageManager}<br /> **Environment:** {contextErr.environment}<br /> **Packages Before Install:** {contextErr.packagesBeforeInstall}</UserMessage>
                        // <UserMessage priority={67}><br /> **Environment:** {envString}<br /></UserMessage>

        //  <UserMessage priority={69}><br /> **Attempted Packages:**{attemptedPackages}<br /> **Package Manager:** {contextErr.packageManager}<br /> **Environment:** {contextErr.environment}<br /> **Packages Before Install:** {contextErr.packagesBeforeInstall}</UserMessage>
        //  <UserMessage priority={60}>## 🛠️ **How to Diagnose & Fix**</UserMessage>
        //         <UserMessage priority={59}><br />1. **Diagnose the error above.**<br />2. **Suggest a fix.**<br />3. Use the following tools where applicable:<br />   - `installPythonPackage`: Install a package with a version specification, etc.<br />   -`configurePythonEnvironment`: Create an environment with the given attributes.<br />   - `getPythonEnvironmentInfo`: Get more information on the user setup if needed.</UserMessage>
// 		return (
//             <>
//                 <UserMessage priority={100}>🚨 **Package Management Error**</UserMessage>
                
//                 <UserMessage priority={90}>## ❗ Error Details</UserMessage>
//                 <UserMessage priority={89}>```
// {contextErr.errorMessage}
// ```</UserMessage>

//                 <UserMessage priority={80}>
//                     Stack Trace
//                         ```
// {contextErr.stackTrace}
// ```
//                 </UserMessage>

//                 <UserMessage priority={70}>## 📝 **Context**</UserMessage>
//                 <UserMessage priority={69}>
//                     - **Attempted Packages:** {contextErr.attemptedPackages.join(', ')}
//                     - **Package Manager:** {contextErr.packageManager}
//                     - **Environment:** {contextErr.environment}
//                     - **Packages Before Install:** {contextErr.packagesBeforeInstall}
//                 </UserMessage>

//                 <UserMessage priority={60}>## 🛠️ **How to Diagnose & Fix**</UserMessage>
//                 <UserMessage priority={59}>
//                     1. **Diagnose the error above.**
//                     2. **Suggest a fix.**
//                     3. Use the following tools where applicable:
//                        - `installPythonPackage`: Install a package with a version specification, etc.
//                        - `configurePythonEnvironment`: Create an environment with the given attributes.
//                        - `getPythonEnvironmentInfo`: Get more information on the user setup if needed.

//                     If you see multiple equally valid paths forward, offer the user a choice in the format:
//                 </UserMessage>
//             </>
//         );
    }
}
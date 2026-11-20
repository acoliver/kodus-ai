/**
 * `kodus chatgpt`: connect a self-hosted Kodus to the org owner's ChatGPT plan
 * ("Sign in with ChatGPT"). The sign-in runs here, on the admin's machine; the
 * server keeps the session and uses it for reviews. Port of OpenCodeReview
 * `cmd/opencodereview/auth_cmd.go` and `chatgpt_auth.go`.
 */
import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';

import { authService } from '../../services/auth.service.js';
import {
    chatGptApi,
    type RealChatGptApi,
} from '../../services/api/chatgpt.api.js';
import {
    CHATGPT_ISSUER,
    CHATGPT_USAGE_URL,
    defaultChatGptLoginDeps,
    runChatGptLogin,
    type ChatGptLoginDeps,
} from '../../services/chatgpt-login.service.js';
import type {
    ChatGptCredentialBundle,
    ChatGptImportRequest,
    ChatGptImportResult,
} from '../../types/chatgpt.js';
import { ApiError } from '../../types/errors.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export interface ChatGptCommandDeps {
    api: Pick<
        RealChatGptApi,
        | 'host'
        | 'registration'
        | 'importSession'
        | 'logout'
        | 'setModel'
        | 'listModels'
        | 'testModel'
    >;
    getUserToken: () => Promise<string | null>;
    login: typeof runChatGptLogin;
    loginDeps: () => ChatGptLoginDeps;
    writeFile: (path: string, content: string) => Promise<void>;
    readFile: (path: string) => Promise<string>;
    out: (line: string) => void;
}

/** Atomic and owner-only: the bundle holds live refresh tokens. */
async function writePrivateFile(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, path);
}

export const defaultChatGptCommandDeps = (): ChatGptCommandDeps => ({
    api: chatGptApi,
    getUserToken: () => authService.getUserToken(),
    login: runChatGptLogin,
    loginDeps: () => defaultChatGptLoginDeps((line) => cliInfo(line)),
    writeFile: writePrivateFile,
    readFile: (path) => fs.readFile(path, 'utf-8'),
    out: (line) => cliInfo(line),
});

export interface ChatGptLoginOptions {
    newAccount?: boolean;
    enablePlan?: boolean;
    replace?: boolean;
    browser?: boolean;
    model?: string;
    setDefault?: boolean;
    output?: string;
}

async function userToken(deps: ChatGptCommandDeps): Promise<string> {
    const token = await deps.getUserToken();
    if (!token) {
        throw new CommandError(
            'AUTH_REQUIRED',
            'kodus chatgpt needs a signed-in organization owner: run `kodus auth login` (team keys cannot manage BYOK).',
        );
    }
    return token;
}

function printImport(
    deps: ChatGptCommandDeps,
    result: ChatGptImportResult,
): void {
    if (result.firstPlanUse) {
        deps.out(
            `You're using your ChatGPT plan. Manage usage: ${CHATGPT_USAGE_URL}`,
        );
    }
    if (result.replacedRevocationConfirmed === false) {
        deps.out(
            'The previous ChatGPT account was signed out here, but OpenAI did not confirm the revocation; disconnect the app in ChatGPT Settings.',
        );
    }
    if (!result.planEnabled) {
        deps.out(
            'Signed in, but ChatGPT plan usage is disabled. Run `kodus chatgpt login --enable-plan` to grant plan permission, or configure an API-key provider.',
        );
        return;
    }
    deps.out(
        `Signed in with ChatGPT${result.email ? ` as ${result.email}` : ''}. Using ChatGPT plan. Manage usage: ${CHATGPT_USAGE_URL}`,
    );
    deps.out(
        "Reviews in this organization consume this ChatGPT account's plan limits.",
    );
    deps.out('Models:');
    for (const m of result.models) {
        deps.out(`  ${m.id}\t${m.name}`);
    }
    deps.out(`Model: ${result.model}`);
}

async function testConnection(
    deps: ChatGptCommandDeps,
    token: string,
    model: string,
    credentialId: string,
): Promise<void> {
    const test = await deps.api.testModel(token, { model, credentialId });
    if (test.ok) {
        deps.out(`Connection test ok (${test.latencyMs} ms).`);
        return;
    }
    throw new CommandError(
        'API_REQUEST_FAILED',
        `Connection test failed (${test.code}): ${test.message ?? test.providerMessage ?? 'no detail'}`,
    );
}

async function upload(
    deps: ChatGptCommandDeps,
    token: string,
    body: ChatGptImportRequest,
): Promise<void> {
    const result = await deps.api.importSession(token, body);
    printImport(deps, result);
    if (result.planEnabled && result.model) {
        await testConnection(deps, token, result.model, result.credentialId);
    }
}

export async function chatGptLoginAction(
    options: ChatGptLoginOptions,
    deps: ChatGptCommandDeps = defaultChatGptCommandDeps(),
): Promise<void> {
    if (options.enablePlan && options.newAccount) {
        throw new CommandError(
            'INVALID_INPUT',
            '--enable-plan requires a retained ChatGPT registration; it cannot be combined with --new-account',
        );
    }
    const token = await userToken(deps);
    const { hostId } = await deps.api.host(token);
    let registration: Awaited<
        ReturnType<ChatGptCommandDeps['api']['registration']>
    >['registration'] = null;
    try {
        registration = (await deps.api.registration(token)).registration;
    } catch (err) {
        // A member who is not an owner may still prepare a bundle for one:
        // only a new registration is possible then.
        if (!(
            options.output &&
            err instanceof ApiError &&
            err.statusCode === 403
        )) {
            throw err;
        }
    }
    if (options.enablePlan && !registration) {
        throw new CommandError(
            'INVALID_INPUT',
            '--enable-plan requires a retained ChatGPT registration; run `kodus chatgpt login` first',
        );
    }
    if (
        registration &&
        options.newAccount &&
        !options.replace &&
        !options.output
    ) {
        throw new CommandError(
            'INVALID_INPUT',
            'This organization already has a ChatGPT registration; pass --replace to sign in a different account',
        );
    }
    const renew = !!registration && !options.newAccount;
    const result = await deps.login(
        {
            hostId,
            registration: renew
                ? {
                      clientId: registration!.clientId,
                      email: registration!.email,
                  }
                : undefined,
            consent: !!options.enablePlan,
            noBrowser: options.browser === false,
        },
        deps.loginDeps(),
    );
    const bundle: ChatGptCredentialBundle = {
        version: 1,
        issuer: CHATGPT_ISSUER,
        clientId: result.clientId,
        extAgentHostId: hostId,
        nonce: result.nonce,
        receivedAt: result.receivedAt.toISOString(),
        newRegistration: !renew,
        expectedRevision: renew ? registration!.revision : null,
        tokenResponse: result.tokenResponse,
    };
    if (options.output) {
        await deps.writeFile(
            options.output,
            `${JSON.stringify(bundle, null, 2)}\n`,
        );
        deps.out(
            `ChatGPT credentials written to ${options.output} (mode 0600). An organization owner uploads them with \`kodus chatgpt import ${options.output}\`; delete the file afterwards.`,
        );
        return;
    }
    await upload(deps, token, {
        bundle,
        model: options.model,
        setDefault: options.setDefault,
        replace: options.replace,
    });
}

export async function chatGptImportAction(
    file: string,
    options: Pick<ChatGptLoginOptions, 'model' | 'setDefault' | 'replace'>,
    deps: ChatGptCommandDeps = defaultChatGptCommandDeps(),
): Promise<void> {
    const token = await userToken(deps);
    let bundle: ChatGptCredentialBundle;
    try {
        bundle = JSON.parse(
            await deps.readFile(file),
        ) as ChatGptCredentialBundle;
    } catch (err) {
        throw new CommandError(
            'INVALID_INPUT',
            `Could not read a ChatGPT credential bundle from ${file}: ${(err as Error).message}`,
        );
    }
    await upload(deps, token, {
        bundle,
        model: options.model,
        setDefault: options.setDefault,
        replace: options.replace,
    });
}

export async function chatGptStatusAction(
    deps: ChatGptCommandDeps = defaultChatGptCommandDeps(),
): Promise<void> {
    const token = await userToken(deps);
    const { hostId, registration: r } = await deps.api.registration(token);
    deps.out(`Host: ${hostId}`);
    if (!r) {
        deps.out('Not signed in, run `kodus chatgpt login`.');
        deps.out(`Manage usage: ${CHATGPT_USAGE_URL}`);
        return;
    }
    let status = 'signed out';
    if (r.identityError) {
        status = `sign-in required: ${r.identityError}`;
    } else if (r.signedIn) {
        status = r.planEnabled
            ? 'Using ChatGPT plan'
            : 'signed in; ChatGPT plan usage disabled; run `kodus chatgpt login --enable-plan`';
    }
    deps.out(`Account: ${r.clientId}`);
    deps.out(`Email: ${r.email ?? ''}`);
    deps.out(`Status: ${status}`);
    if (r.signedIn && r.expiresAt) {
        deps.out(`Expires: ${r.expiresAt}`);
    }
    if (r.pendingVerification) {
        deps.out('A token refresh is waiting for identity verification.');
    }
    deps.out(`Manage usage: ${CHATGPT_USAGE_URL}`);
}

export async function chatGptLogoutAction(
    deps: ChatGptCommandDeps = defaultChatGptCommandDeps(),
): Promise<void> {
    const token = await userToken(deps);
    let result;
    try {
        result = await deps.api.logout(token);
    } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
            deps.out(
                'No ChatGPT registration was found for this organization.',
            );
            return;
        }
        throw err;
    }
    if (!result.revocationConfirmed) {
        throw new CommandError(
            'API_REQUEST_FAILED',
            `Tokens cleared; remote revocation not confirmed, disconnect the app in ChatGPT Settings: ${result.revocationError ?? 'unknown error'}`,
        );
    }
    deps.out(
        'ChatGPT session revoked and tokens cleared. Account registration and host ID retained.',
    );
}

export async function chatGptModelsAction(
    deps: ChatGptCommandDeps = defaultChatGptCommandDeps(),
): Promise<void> {
    const token = await userToken(deps);
    const { models } = await deps.api.listModels(token);
    for (const m of models) {
        deps.out(`${m.id}\t${m.name}`);
    }
}

export async function chatGptUseAction(
    slug: string,
    options: { setDefault?: boolean },
    deps: ChatGptCommandDeps = defaultChatGptCommandDeps(),
): Promise<void> {
    const token = await userToken(deps);
    const result = await deps.api.setModel(token, {
        model: slug,
        setDefault: options.setDefault,
    });
    deps.out(`ChatGPT model set to ${result.model}.`);
    const { registration } = await deps.api.registration(token);
    if (registration) {
        await testConnection(
            deps,
            token,
            result.model,
            registration.credentialId,
        );
    }
}

/** Run an action, reporting a failure the way every command does. */
function run<A extends unknown[]>(
    action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
    return async (...args: A) => {
        try {
            await action(...args);
        } catch (error) {
            const normalized = normalizeCommandError(error);
            cliError(chalk.red(normalized.message));
            exitWithCode(normalized.exitCode);
        }
    };
}

export function createChatGptCommand(): Command {
    const command = new Command('chatgpt')
        .description(
            "Use the organization owner's ChatGPT plan for reviews (Sign in with ChatGPT, self-hosted Kodus only). Requires kodus auth login.",
        )
        .showHelpAfterError();

    command
        .command('login')
        .description(
            'Sign in with ChatGPT in your browser and connect the plan to this Kodus deployment.',
        )
        .option(
            '--new-account',
            'register a separate ChatGPT account or workspace',
        )
        .option(
            '--enable-plan',
            'ask again for consent to plan usage on the retained registration',
        )
        .option(
            '--replace',
            "replace the organization's ChatGPT account (with --new-account)",
        )
        .option(
            '--no-browser',
            'print a one-time local URL instead of opening a browser',
        )
        .option(
            '--model <slug>',
            'model to use (default: the first one your account lists)',
        )
        .option(
            '--set-default',
            'route reviews to the ChatGPT model by default',
        )
        .action(
            run(async (options: ChatGptLoginOptions, cmd: Command) => {
                const globals = cmd.optsWithGlobals() as { output?: string };
                await chatGptLoginAction({
                    ...options,
                    output: globals.output,
                });
            }),
        );

    command
        .command('import <file>')
        .description(
            'Upload a credential bundle written by `kodus chatgpt login --output <file>`.',
        )
        .option(
            '--model <slug>',
            'model to use (default: the first one listed)',
        )
        .option(
            '--set-default',
            'route reviews to the ChatGPT model by default',
        )
        .option('--replace', "replace the organization's ChatGPT account")
        .action(
            run((file: string, options: ChatGptLoginOptions) =>
                chatGptImportAction(file, options),
            ),
        );

    command
        .command('status')
        .description("Show the organization's ChatGPT registration")
        .action(run(() => chatGptStatusAction()));

    command
        .command('logout')
        .description('Revoke the ChatGPT session and clear its tokens')
        .action(run(() => chatGptLogoutAction()));

    command
        .command('models')
        .description('List the models your ChatGPT account offers')
        .action(run(() => chatGptModelsAction()));

    command
        .command('use <slug>')
        .description('Choose the ChatGPT model reviews use')
        .option('--set-default', 'route reviews to it by default')
        .action(
            run((slug: string, options: { setDefault?: boolean }) =>
                chatGptUseAction(slug, options),
            ),
        );

    return command;
}

export const chatgptCommand = createChatGptCommand();

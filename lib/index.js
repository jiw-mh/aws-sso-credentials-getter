import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import ini from "js-ini"
import path from "path"
import { SSOClient, GetRoleCredentialsCommand } from "@aws-sdk/client-sso"
import { spawn } from "child_process"

const configPath = homedir => path.resolve(homedir, ".aws/config")
const credentialsPath = homedir => path.resolve(homedir, ".aws/credentials")
const cacheFolder = homedir => path.resolve(homedir, "./.aws/sso/cache")

export class KnownError extends Error {}

function indent (str, indent) {
    return `${indent}${str.split('\n').join(`\n${indent}`)}`
}

const readConfig = (homedir) => {
    const file = configPath(homedir)
    if (!existsSync(file)) {
        throw new KnownError("Configuration file not found. Please run: aws configure sso")
    }

    return ini.parse(readFileSync(file, "utf-8"))
}

const updateCreds = (homedir, credsUpdate) => {
    const file = credentialsPath(homedir)
    writeFileSync(file, ini.stringify({
        ...existsSync(file) ? ini.parse(readFileSync(file, "utf-8")) : {},
        ...credsUpdate
    }))
}

const getCachedAccessToken = (homedir, startUrl) => {
    const folder = cacheFolder(homedir)
    let found
    for (const file of readdirSync(folder)) {
        let data
        try {
            data = JSON.parse(
                readFileSync(path.resolve(folder, file), "utf-8")
            )
        } catch (err) {
            // Ignore non-json files
            continue
        }
        if (!data.accessToken) {
            continue
        }
        if (data.startUrl !== startUrl) {
            continue
        }
        if (found && found.expiresAt > data.expiresAt) {
            continue
        }
        found = data
    }
    return found
}

function removePrefix (prefix, value) {
    if (!value.startsWith(prefix)) {
        return
    }
    return value.substring(prefix.length)
}

function getPrefixed (prefix, object) {
    const result = {}
    for (const [key, value] of Object.entries(object)) {
        const removedKey = removePrefix(prefix, key)
        if (!removedKey) continue
        result[removedKey] = value
    }
    return result
}

const getProfileConfig = (homedir, profile) => {
    const config = readConfig(homedir)
    const ssoSessions = getPrefixed('sso-session ', config)
    const profiles = getPrefixed('profile ', config)

    if (config.default) {
        profiles.default = config.default
    }

    const profileConfigs = {}
    for (const name in profiles) {
        profileConfigs[name] = {
            ...ssoSessions[name],
            ...profiles[name]
        }
    }

    const profileConfig = profileConfigs[profile]
    if (!profileConfig) {
            throw new KnownError(`
    The sso profile '${profile}' could not be found in ${configPath(homedir)}

    Known profiles:

    ${indent(Object.keys(profileConfigs).map(name => `- ${name}`).join('\n'), '    ')}

    Maybe setup the profile using ↓ ?

    $ aws configure sso
`)
    }
    if (
        (
            !profileConfig.sso_region && !profileConfig.region
        ) ||
        !profileConfig.sso_account_id ||
        !profileConfig.sso_role_name ||
        !profileConfig.sso_start_url
    ) {
        throw new KnownError(`
    The profile and sso-session '${profile}' is not a valid SSO profile.

    A valid SSO profile must contain the following fields:
        - sso_region (or "region")
        - sso_account_id
        - sso_role_name
        - sso_start_url

    Found: ${JSON.stringify(profileConfig, null, 2)}
`)
    }
    const sameSSOUrl = []
    for (const [key, otherConfig] of Object.entries(profileConfigs)) {
        if (profileConfig.sso_start_url === otherConfig.sso_start_url) {
            sameSSOUrl.push(key)
        }
    }
    if (sameSSOUrl.length > 1) {
        throw new KnownError(`

    There is more than one sso-session with the sso_start_url=${profileConfig.sso_start_url} in ${configPath(homedir)}

        ${indent(sameSSOUrl.map(name => `- ${name}`).join('\n'), '        ')}

`)
    }
    return profileConfig
}

const login = (profile) => {
    return new Promise((res, rej) => {
        console.log("Trying to log you in")
        const child = spawn("aws", ["sso", "login", "--profile", profile])

        child.stdout.on("data", (data) => {
            console.log(`\n${data}`)
        })

        child.stderr.on("data", (data) => {
            console.error(`ERROR: ${data}`)
        })

        child.on("error", (error) => {
            console.error(`ERROR: ${error.message}`)
            rej(error)
        })

        child.on("close", (code) => {
            if (code === 0) {
                return res()
            }

            rej(new Error(`Login ended with code: ${code}`))
        })
    })
}

export async function setCreds (homedir, profile, customProfile, force = false) {
    const profileConfig = getProfileConfig(homedir, profile)

    const {
        sso_region,
        region,
        sso_account_id: accountId,
        sso_role_name: roleName,
        sso_start_url: startUrl,
    } = profileConfig

    let cachedToken = force ? null : getCachedAccessToken(homedir, startUrl)
    if (!cachedToken || cachedToken.expiresAt < (new Date()).toISOString()) {
        if (force) {
            console.log('[FORCE]')
        }
        // TODO: maybe a simple aws cli call with the profile might refresh the session?
        await login(profile)
        cachedToken = getCachedAccessToken(homedir, startUrl)
        if (!cachedToken) {
            throw new KnownError('No AccessToken available available after login.')
        }
    }

    const sso = new SSOClient({
        region: sso_region ?? region
    })

    const { roleCredentials } = await sso.send(new GetRoleCredentialsCommand({
        accessToken: cachedToken.accessToken,
        accountId,
        roleName,
    }))

    const newCreds = {
        aws_access_key_id: roleCredentials.accessKeyId,
        aws_secret_access_key: roleCredentials.secretAccessKey,
        aws_session_token: roleCredentials.sessionToken,
        expiration: roleCredentials.expiration,
    }

    const credKey = customProfile ?? profile
    updateCreds(homedir, {
        [credKey]: newCreds,
    })

    return {
        profile,
        credKey,
        newCreds
    }
}

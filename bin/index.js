#!/usr/bin/env node
import { setCreds, KnownError } from '../lib/index.js'
import { homedir } from 'os'
import { utcToZonedTime } from 'date-fns-tz'

// Delete the 0 and 1 argument (node and script.js)
const args = process.argv.splice(process.execArgv.length + 2)

// Retrieve the first argument
const profile = args[0] || 'default'

const customProfile = args[1] || undefined 

const force = args[2] ? /^\s*true\s*$/i.test(args[2]) : false

function timeDiff (expirationStr) {
    const expiration = new Date(expirationStr)
    const now = new Date()
    return `${Math.floor((expiration.getTime() - now.getTime()) / (1000 * 60))} minutes`
}

function indent (msg, indent) {
    return indent + msg.split('\n').join('\n' + indent)
}

// Displays the text in the console
setCreds(homedir(), profile, customProfile, force).then(
    ({ profile, credKey, newCreds }) => {
        console.log(`

    --- SUCCESS ---
    Signed-in: --sso_session=${profile}
    Activated: aws --profile=${credKey}
    Expires at: ${utcToZonedTime(newCreds.expiration)}
    Expires in: ${timeDiff(newCreds.expiration)}
    ---------------

`)
    },
    e => {
        console.error(`

    --- ERROR ---
${(e instanceof KnownError) ? indent(e.message, '    ') : `
    Something unexpected went wrong:
${indent(String(e), '        ')}`}
    -------------

`)
        process.exit(1)
    }
)

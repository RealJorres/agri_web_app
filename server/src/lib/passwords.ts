import argon2 from 'argon2'

import { normalizeName } from './text.js'

const MIN_LENGTH = 12
const COMMON = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiop123',
  '123456789012',
  'administrator',
  'adminadmin123',
  'iloveyou1234',
  'letmeinletmein',
  'welcome12345',
  'changeme1234',
])

// Verified when the email is unknown, so the response time does not reveal which emails exist.
const unknownUserHash = argon2.hash('no account has this password')

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password)
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  const matched = await argon2.verify(hash ?? (await unknownUserHash), password)
  return hash !== null && matched
}

/** Problems with a new password (empty when it is acceptable). */
export function passwordProblems(password: string, personal: readonly string[] = []): string[] {
  const problems: string[] = []
  if (password.length < MIN_LENGTH) {
    problems.push(`Use at least ${MIN_LENGTH} characters.`)
  }
  if (/^\d+$/.test(password)) problems.push('Do not use only numbers.')
  if (COMMON.has(password.toLowerCase())) problems.push('This password is too common.')
  const lowered = normalizeName(password).replaceAll(' ', '')
  const similar = personal
    .flatMap((value) => normalizeName(value).split(' '))
    .some((part) => part.length >= 4 && lowered.includes(part))
  if (similar) problems.push('Do not use your name or email in the password.')
  return problems
}

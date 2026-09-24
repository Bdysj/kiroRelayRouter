import { type auth as zhAuth } from '../zh/auth'

export const auth: typeof zhAuth = {
  tagline: 'Let stronger models drive your intelligent world',
  slogan: 'More open · More stable · More capable',
  signIn: {
    title: 'Administrator sign in',
    desc: 'Sign in to the kiro Relayrouter control center with an admin account',
    username: 'Admin account',
    usernamePlaceholder: 'Enter your account',
    usernameRequired: 'Enter the admin account',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    passwordRequired: 'Enter the admin password',
    submit: 'Sign in',
    success: 'Signed in',
    failed: 'Sign-in failed',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
  },
}

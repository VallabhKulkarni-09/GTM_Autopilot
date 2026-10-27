import { LoginForm } from './login-form'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams
  return <LoginForm linkError={typeof error === 'string' ? error : null} />
}

'use client';

import { useRouter } from 'next/navigation';
import { loginSchema } from '@ff/shared/schemas/setup';
import { useSession } from '@/entities/session';
import { useApiForm } from '@/shared/lib/use-api-form';
import { Banner, Button, Field, TextInput } from '@/shared/ui';

export const LoginForm = () => {
  const { login } = useSession();
  const router = useRouter();
  const { form, banner, submit } = useApiForm(loginSchema, { email: '', password: '' });
  const { register, formState } = form;
  return (
    <form
      className="flex max-w-sm flex-col gap-4"
      onSubmit={submit(
        async (v) => {
          await login(v.email, v.password);
          router.replace('/');
        },
        ['email', 'password'],
      )}
      noValidate
    >
      {banner !== null && <Banner kind="error">{banner}</Banner>}
      <Field label="Email" error={formState.errors.email?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="email"
            autoComplete="username"
            autoFocus
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('email')}
          />
        )}
      </Field>
      <Field label="Password" error={formState.errors.password?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="password"
            autoComplete="current-password"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('password')}
          />
        )}
      </Field>
      <Button type="submit" disabled={formState.isSubmitting}>
        Sign in
      </Button>
    </form>
  );
};

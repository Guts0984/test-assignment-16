'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import {
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
  useForm,
} from 'react-hook-form';
import type { z } from 'zod';
import { applyApiErrors } from './form-errors';

/**
 * A form validated by the same zod schema the server uses. Client errors and the api's field errors
 * both land under the fields; anything that matches no field goes to the banner.
 */
export const useApiForm = <S extends z.ZodTypeAny, V extends FieldValues = z.input<S>>(
  schema: S,
  defaults: DefaultValues<V>,
) => {
  const form: UseFormReturn<V, unknown, z.output<S>> = useForm<V, unknown, z.output<S>>({
    resolver: zodResolver(schema) as never,
    defaultValues: defaults,
  });
  const [banner, setBanner] = useState<string | null>(null);
  const submit = (run: (values: z.output<S>) => Promise<unknown>, fields: readonly string[]) =>
    form.handleSubmit(async (values) => {
      setBanner(null);
      try {
        await run(values);
      } catch (e) {
        setBanner(applyApiErrors(e, (name, err) => form.setError(name as Path<V>, err), fields));
      }
    });
  return { form, banner, submit };
};

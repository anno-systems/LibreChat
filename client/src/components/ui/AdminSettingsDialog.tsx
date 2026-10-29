import { useId, useEffect, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useForm, Controller } from 'react-hook-form';
import { SystemRoles } from 'librechat-data-provider';
import { ChevronDown, ShieldEllipsis } from 'lucide-react';
import {
  Label,
  Button,
  Switch,
  OGDialog,
  DropdownPopup,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogFooter,
  OGDialogContent,
  OGDialogTrigger,
  OGDialogDescription,
} from '@librechat/client';
import type { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { Control } from 'react-hook-form';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize, useAuthContext, useRoleSelector } from '~/hooks';

type FormValues = Record<Permissions, boolean>;

export interface PermissionConfig {
  permission: Permissions;
  labelKey: TranslationKeys;
}

export interface AdminSettingsDialogProps {
  /** The permission type from PermissionTypes enum */
  permissionType: PermissionTypes;
  /** Localization key for the section name (e.g., 'com_ui_memories', 'com_ui_agents') */
  sectionKey: TranslationKeys;
  /** Array of permission configurations to display */
  permissions: PermissionConfig[];
  /** Unique ID for the role dropdown menu */
  menuId: string;
  /** Mutation function and loading state from the permission update hook */
  mutation: {
    mutate: (data: { roleName: string; updates: Record<Permissions, boolean> }) => void;
    isLoading: boolean;
    /** When it flips true the dialog closes itself */
    isSuccess?: boolean;
  };
  /** Localization key for the screen-reader description of the dialog */
  descriptionKey?: TranslationKeys;
  /** Label of the default trigger, which names what it manages (e.g. 'com_ui_manage_agents') */
  triggerLabelKey?: TranslationKeys;
  /** Custom trigger element. If not provided, uses default button with icon and text */
  trigger?: React.ReactNode;
  /** Additional className for the dialog content */
  dialogContentClassName?: string;
  /** Custom content to render after the permissions form (e.g., confirmation dialogs) */
  extraContent?: React.ReactNode;
}

type LabelControllerProps = {
  id: string;
  label: string;
  permission: Permissions;
  control: Control<FormValues, unknown, FormValues>;
};

const LabelController: React.FC<LabelControllerProps> = ({ id, control, permission, label }) => (
  <div className="flex items-center justify-between gap-4 px-4 py-3.5">
    <Label
      htmlFor={id}
      className="w-auto cursor-pointer text-sm font-medium break-normal select-none"
    >
      {label}
    </Label>
    <Controller
      name={permission}
      control={control}
      render={({ field }) => (
        <Switch
          {...field}
          id={id}
          checked={field.value ?? false}
          onCheckedChange={field.onChange}
          value={(field.value ?? false).toString()}
          aria-label={label}
        />
      )}
    />
  </div>
);

const AdminSettingsDialog: React.FC<AdminSettingsDialogProps> = ({
  permissionType,
  sectionKey,
  permissions,
  menuId,
  mutation,
  descriptionKey,
  triggerLabelKey = 'com_ui_admin_settings',
  trigger,
  dialogContentClassName,
  extraContent,
}) => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { mutate, isLoading, isSuccess } = mutation;

  const idPrefix = useId();
  const roleLabelId = useId();
  const roleValueId = useId();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isRoleMenuOpen, setIsRoleMenuOpen] = useState(false);
  const [wasSuccessful, setWasSuccessful] = useState(isSuccess);
  const {
    selectedRole,
    isSelectedCustomRole,
    isCustomRoleLoading,
    isCustomRoleError,
    defaultValues,
    roleDropdownItems,
  } = useRoleSelector(permissionType);

  const {
    reset,
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<FormValues>({
    mode: 'onChange',
    defaultValues,
  });

  useEffect(() => {
    if (isSelectedCustomRole && (isCustomRoleLoading || isCustomRoleError)) {
      return;
    }
    reset(defaultValues);
  }, [isSelectedCustomRole, isCustomRoleLoading, isCustomRoleError, defaultValues, reset]);

  if (isSuccess !== wasSuccessful) {
    setWasSuccessful(isSuccess);
    if (isSuccess === true && isDialogOpen) {
      setIsDialogOpen(false);
    }
  }

  if (user?.role !== SystemRoles.ADMIN) {
    return null;
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setIsRoleMenuOpen(false);
      reset(defaultValues);
    }
    setIsDialogOpen(open);
  };

  const onSubmit = (data: FormValues) => {
    mutate({ roleName: selectedRole, updates: data });
  };

  const defaultTrigger = (
    <Button
      size="sm"
      variant="outline"
      className="relative h-9 w-full font-medium"
      aria-label={localize(triggerLabelKey)}
    >
      <ShieldEllipsis className="size-5 cursor-pointer" aria-hidden="true" />
      {localize(triggerLabelKey)}
    </Button>
  );

  return (
    <>
      <OGDialog open={isDialogOpen} onOpenChange={handleDialogOpenChange}>
        <OGDialogTrigger asChild>{trigger ?? defaultTrigger}</OGDialogTrigger>
        <OGDialogContent
          className={dialogContentClassName ?? 'w-11/12 max-w-2xl gap-0 overflow-hidden p-0'}
        >
          <OGDialogHeader className="px-5 py-5 pe-14 text-start sm:px-6">
            <div className="flex items-center gap-3">
              <div className="border-border-light bg-surface-secondary text-text-secondary flex size-10 shrink-0 items-center justify-center rounded-xl border">
                <ShieldEllipsis className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 space-y-1">
                <OGDialogTitle className="text-xl leading-7">
                  {localize('com_ui_admin_settings_section', { section: localize(sectionKey) })}
                </OGDialogTitle>
                {descriptionKey && (
                  <OGDialogDescription className="sr-only">
                    {localize(descriptionKey)}
                  </OGDialogDescription>
                )}
              </div>
            </div>
          </OGDialogHeader>

          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="space-y-4 p-4 sm:p-6">
              <div className="border-border-light bg-surface-secondary grid gap-3 rounded-xl border p-4 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center">
                <span id={roleLabelId} className="text-text-primary text-sm font-semibold">
                  {localize('com_ui_role_select')}
                </span>
                <DropdownPopup
                  unmountOnHide={true}
                  menuId={menuId}
                  isOpen={isRoleMenuOpen}
                  setIsOpen={setIsRoleMenuOpen}
                  trigger={
                    <Ariakit.MenuButton
                      aria-labelledby={`${roleLabelId} ${roleValueId}`}
                      className="border-border-medium text-text-primary hover:bg-surface-hover focus-visible:ring-text-primary inline-flex h-10 w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
                    >
                      <span id={roleValueId} className="truncate font-medium">
                        {selectedRole}
                      </span>
                      <ChevronDown
                        className="text-text-secondary size-4 shrink-0"
                        aria-hidden="true"
                      />
                    </Ariakit.MenuButton>
                  }
                  items={roleDropdownItems}
                  itemClassName="items-center justify-center"
                  sameWidth={true}
                />
              </div>

              <div className="divide-border-light border-border-light bg-surface-secondary divide-y overflow-hidden rounded-xl border">
                {permissions.map(({ permission, labelKey }) => (
                  <LabelController
                    key={permission}
                    id={`${idPrefix}-${permission}`}
                    control={control}
                    permission={permission}
                    label={localize(labelKey)}
                  />
                ))}
              </div>
            </div>

            <OGDialogFooter className="bg-transparent px-4 py-4 sm:px-6">
              <Button
                type="submit"
                variant="submit"
                disabled={
                  isSubmitting ||
                  isLoading ||
                  (isSelectedCustomRole && (isCustomRoleLoading || isCustomRoleError))
                }
                className="font-bold"
                aria-label={localize('com_ui_save')}
              >
                {localize('com_ui_save')}
              </Button>
            </OGDialogFooter>
          </form>
        </OGDialogContent>
      </OGDialog>
      {extraContent}
    </>
  );
};

export default AdminSettingsDialog;

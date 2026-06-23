'use client'

/**
 * @fileoverview 編輯用戶對話框組件
 * @description
 *   提供系統管理員編輯用戶資料的表單對話框。
 *   支援用戶名稱修改、角色變更、城市指派等功能。
 *
 *   功能特點：
 *   - Email 唯讀顯示（不可修改）
 *   - 名稱編輯
 *   - 角色多選（至少選擇一個）
 *   - 城市選擇
 *   - 表單驗證錯誤提示
 *   - 提交載入狀態
 *   - 成功/失敗 Toast 通知
 *
 *   權限要求：
 *   - USER_MANAGE 權限（由呼叫端控制顯示）
 *
 * @module src/components/features/admin/EditUserDialog
 * @author Development Team
 * @since Epic 1 - Story 1.5 (Modify User Role & City)
 * @lastModified 2025-12-18
 *
 * @dependencies
 *   - react-hook-form - 表單狀態管理
 *   - @hookform/resolvers/zod - Zod 驗證整合
 *   - @/hooks/use-users - 更新用戶 Hook
 *   - @/hooks/use-roles - 角色列表 Hook
 *   - @/hooks/use-cities - 城市列表 Hook
 *   - @/hooks/use-toast - Toast 通知
 *
 * @related
 *   - src/app/(dashboard)/admin/users/page.tsx - 用戶列表頁面
 *   - src/lib/validations/user.schema.ts - 驗證 Schema
 *   - src/components/features/admin/AddUserDialog.tsx - 新增用戶對話框
 */

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'

import {
  useUpdateUser,
  useResetUserPassword,
  type UserDetail,
} from '@/hooks/use-users'
import { useRoles } from '@/hooks/use-roles'
import { useCities } from '@/hooks/use-cities'
import { useToast } from '@/hooks/use-toast'
import {
  updateUserSchema,
  adminResetPasswordSchema,
  type UpdateUserInput,
  type AdminResetPasswordInput,
} from '@/lib/validations/user.schema'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ============================================================
// Types
// ============================================================

interface EditUserDialogProps {
  /** 要編輯的用戶資料 */
  user: UserDetail | null
  /** 對話框是否開啟 */
  open: boolean
  /** 對話框開關狀態變更回調 */
  onOpenChange: (open: boolean) => void
}

// ============================================================
// Component
// ============================================================

/**
 * 編輯用戶對話框
 *
 * @description
 *   提供完整的編輯用戶表單功能，包含驗證和提交。
 *   成功更新後自動刷新用戶列表並顯示通知。
 *
 * @example
 *   <EditUserDialog
 *     user={selectedUser}
 *     open={isEditDialogOpen}
 *     onOpenChange={setIsEditDialogOpen}
 *   />
 */
export function EditUserDialog({ user, open, onOpenChange }: EditUserDialogProps) {
  // --- i18n ---
  const t = useTranslations('admin')

  // --- Hooks ---
  const { toast } = useToast()
  const { mutate: updateUser, isPending } = useUpdateUser()
  // CHANGE-082: 重設密碼
  const { mutate: resetPassword, isPending: isResetting } = useResetUserPassword()
  const { data: roles, isLoading: isLoadingRoles } = useRoles()
  const { data: cities, isLoading: isLoadingCities } = useCities()

  // --- Form ---
  const form = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      name: '',
      roleIds: [],
      cityId: null,
    },
  })

  // CHANGE-082: 重設密碼表單（獨立於主編輯表單）
  const passwordForm = useForm<AdminResetPasswordInput>({
    resolver: zodResolver(adminResetPasswordSchema),
    defaultValues: {
      newPassword: '',
      confirmPassword: '',
    },
  })

  // --- Effects ---
  // 當用戶資料變更時，重置表單
  useEffect(() => {
    if (user && open) {
      // 提取用戶當前的角色 ID 列表
      const currentRoleIds = user.roles.map((r) => r.roleId)
      // 提取用戶當前的城市 ID（取第一個有城市的角色）
      const currentCityId = user.roles.find((r) => r.cityId)?.cityId || null

      form.reset({
        name: user.name || '',
        roleIds: currentRoleIds,
        cityId: currentCityId,
      })
      // CHANGE-082: 開啟時清空密碼表單
      passwordForm.reset({ newPassword: '', confirmPassword: '' })
    }
  }, [user, open, form, passwordForm])

  // --- Handlers ---
  const onSubmit = (data: UpdateUserInput) => {
    if (!user) return

    updateUser(
      { userId: user.id, data },
      {
        onSuccess: () => {
          toast({
            title: t('users.toast.updated.title'),
            description: t('users.toast.updated.description', { name: data.name || user.email }),
          })
          onOpenChange(false)
        },
        onError: (error) => {
          toast({
            variant: 'destructive',
            title: t('users.toast.updateError.title'),
            description: error.message,
          })
        },
      }
    )
  }

  // CHANGE-082: 重設密碼送出
  const onResetPassword = (data: AdminResetPasswordInput) => {
    if (!user) return

    resetPassword(
      { userId: user.id, data },
      {
        onSuccess: () => {
          toast({
            title: t('users.toast.passwordReset.title'),
            description: t('users.toast.passwordReset.description', {
              name: user.name || user.email,
            }),
          })
          passwordForm.reset({ newPassword: '', confirmPassword: '' })
        },
        onError: (error) => {
          toast({
            variant: 'destructive',
            title: t('users.toast.passwordResetError.title'),
            description: error.message,
          })
        },
      }
    )
  }

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen)
    if (!newOpen) {
      // 關閉時重置表單
      form.reset()
      passwordForm.reset({ newPassword: '', confirmPassword: '' })
    }
  }

  // --- Render ---
  if (!user) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('users.dialog.editTitle')}</DialogTitle>
          <DialogDescription>{t('users.dialog.editDescription')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Email 欄位（唯讀） */}
            <FormItem>
              <FormLabel>{t('users.form.email')}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  value={user.email}
                  disabled
                  className="bg-muted cursor-not-allowed"
                />
              </FormControl>
              <FormDescription>{t('users.dialog.editEmailDescription')}</FormDescription>
            </FormItem>

            {/* 名稱欄位 */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('users.form.name')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('users.form.namePlaceholder')} autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 角色欄位 */}
            <FormField
              control={form.control}
              name="roleIds"
              render={() => (
                <FormItem>
                  <div className="mb-2">
                    <FormLabel>{t('users.form.roles')}</FormLabel>
                    <FormDescription>{t('users.form.rolesDescription')}</FormDescription>
                  </div>
                  <div className="space-y-2">
                    {isLoadingRoles ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('users.form.rolesLoading')}
                      </div>
                    ) : (
                      roles?.map((role) => (
                        <FormField
                          key={role.id}
                          control={form.control}
                          name="roleIds"
                          render={({ field }) => (
                            <FormItem className="flex items-center space-x-3 space-y-0">
                              <FormControl>
                                <Checkbox
                                  checked={field.value?.includes(role.id)}
                                  onCheckedChange={(checked) => {
                                    const current = field.value || []
                                    if (checked) {
                                      field.onChange([...current, role.id])
                                    } else {
                                      field.onChange(current.filter((id) => id !== role.id))
                                    }
                                  }}
                                />
                              </FormControl>
                              <FormLabel className="font-normal cursor-pointer">
                                {role.name}
                                {role.description && (
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    ({role.description})
                                  </span>
                                )}
                              </FormLabel>
                            </FormItem>
                          )}
                        />
                      ))
                    )}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 城市欄位 */}
            <FormField
              control={form.control}
              name="cityId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('users.form.cityOptional')}</FormLabel>
                  <Select
                    value={field.value || '__none__'}
                    onValueChange={(value) => field.onChange(value === '__none__' ? null : value)}
                    disabled={isLoadingCities}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('users.form.cityPlaceholder')}>
                          {isLoadingCities ? (
                            <span className="flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {t('users.form.cityLoading')}
                            </span>
                          ) : field.value ? (
                            cities?.find((c) => c.id === field.value)?.name || t('users.form.cityPlaceholder')
                          ) : (
                            t('users.form.cityPlaceholder')
                          )}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none__">{t('users.form.cityEmpty')}</SelectItem>
                      {cities?.map((city) => (
                        <SelectItem key={city.id} value={city.id}>
                          {city.name} ({city.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t('users.form.cityDescription')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('users.dialog.cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('users.dialog.submitEdit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {/* 重設密碼區塊（CHANGE-082；獨立表單，避免巢狀 form） */}
        <div className="border-t pt-4">
          <h4 className="text-sm font-medium">{t('users.dialog.resetPasswordTitle')}</h4>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('users.dialog.resetPasswordDescription')}
          </p>
          <Form {...passwordForm}>
            <form
              onSubmit={passwordForm.handleSubmit(onResetPassword)}
              className="space-y-4"
            >
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.form.newPassword')}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        placeholder={t('users.form.passwordPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.form.confirmPassword')}</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button type="submit" variant="outline" disabled={isResetting}>
                  {isResetting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('users.dialog.resetPasswordSubmit')}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  )
}

'use client'

/**
 * @fileoverview 新增用戶對話框組件
 * @description
 *   提供系統管理員手動新增用戶的表單對話框。
 *   支援用戶資料驗證、角色選擇、城市指派等功能。
 *
 *   功能特點：
 *   - Email 格式驗證（需與 Azure AD 一致）
 *   - 角色多選（至少選擇一個）
 *   - 城市選擇（City Manager 可選）
 *   - 表單驗證錯誤提示
 *   - 提交載入狀態
 *   - 成功/失敗 Toast 通知
 *
 *   權限要求：
 *   - USER_MANAGE 權限（由呼叫端控制顯示）
 *
 * @module src/components/features/admin/AddUserDialog
 * @author Development Team
 * @since Epic 1 - Story 1.4 (Add User & Role Assignment)
 * @lastModified 2025-12-18
 *
 * @dependencies
 *   - react-hook-form - 表單狀態管理
 *   - @hookform/resolvers/zod - Zod 驗證整合
 *   - @/hooks/use-users - 創建用戶 Hook
 *   - @/hooks/use-roles - 角色列表 Hook
 *   - @/hooks/use-cities - 城市列表 Hook
 *   - @/hooks/use-toast - Toast 通知
 *
 * @related
 *   - src/app/(dashboard)/admin/users/page.tsx - 用戶列表頁面
 *   - src/lib/validations/user.schema.ts - 驗證 Schema
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Loader2 } from 'lucide-react'

import { useCreateUser } from '@/hooks/use-users'
import { useRoles } from '@/hooks/use-roles'
import { useCities } from '@/hooks/use-cities'
import { useToast } from '@/hooks/use-toast'
import { createUserSchema, type CreateUserInput } from '@/lib/validations/user.schema'

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
  DialogTrigger,
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

interface AddUserDialogProps {
  /** 按鈕觸發器變體 */
  triggerVariant?: 'default' | 'outline' | 'ghost'
  /** 按鈕大小 */
  triggerSize?: 'default' | 'sm' | 'lg' | 'icon'
  /** 自定義類名 */
  className?: string
}

// ============================================================
// Component
// ============================================================

/**
 * 新增用戶對話框
 *
 * @description
 *   提供完整的新增用戶表單功能，包含驗證和提交。
 *   成功創建後自動刷新用戶列表並顯示通知。
 *
 * @example
 *   <AddUserDialog />
 *   <AddUserDialog triggerVariant="outline" />
 */
export function AddUserDialog({
  triggerVariant = 'default',
  triggerSize = 'default',
  className,
}: AddUserDialogProps) {
  const t = useTranslations('admin')

  // --- State ---
  const [open, setOpen] = useState(false)

  // --- Hooks ---
  const { toast } = useToast()
  const { mutate: createUser, isPending } = useCreateUser()
  const { data: roles, isLoading: isLoadingRoles } = useRoles()
  const { data: cities, isLoading: isLoadingCities } = useCities()

  // --- Form ---
  const form = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      email: '',
      name: '',
      roleIds: [],
      cityId: null,
      password: '',
    },
  })

  // --- Handlers ---
  const onSubmit = (data: CreateUserInput) => {
    createUser(data, {
      onSuccess: () => {
        toast({
          title: t('users.toast.created.title'),
          description: t('users.toast.created.description', { name: data.name }),
        })
        setOpen(false)
        form.reset()
      },
      onError: (error) => {
        toast({
          variant: 'destructive',
          title: t('users.toast.createError.title'),
          description: error.message,
        })
      },
    })
  }

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (!newOpen) {
      // 關閉時重置表單
      form.reset()
    }
  }

  // --- Render ---
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize} className={className}>
          <Plus className="mr-2 h-4 w-4" />
          {t('users.actions.create')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('users.dialog.createTitle')}</DialogTitle>
          <DialogDescription>
            {t('users.dialog.createDescription')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Email 欄位 */}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('users.form.email')}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="user@company.com"
                      autoComplete="off"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('users.form.emailDescription')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 名稱欄位 */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('users.form.name')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t('users.form.namePlaceholder')}
                      autoComplete="off"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 初始密碼欄位（可選，CHANGE-082；僅本地帳號） */}
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('users.form.passwordOptional')}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t('users.form.passwordPlaceholder')}
                      autoComplete="new-password"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('users.form.passwordCreateDescription')}
                  </FormDescription>
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
                    <FormDescription>
                      {t('users.form.rolesDescription')}
                    </FormDescription>
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
                                      field.onChange(
                                        current.filter((id) => id !== role.id)
                                      )
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
                            cities?.find((c) => c.id === field.value)?.name ||
                            t('users.form.cityPlaceholder')
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
                  <FormDescription>
                    {t('users.form.cityDescription')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                {t('users.dialog.cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('users.dialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

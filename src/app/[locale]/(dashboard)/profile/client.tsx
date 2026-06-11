/**
 * @fileoverview 個人資料頁面 Client Component
 * @description
 *   當前登入用戶的個人資料管理介面。
 *   分區顯示：基本資訊、角色權限、語言偏好、密碼修改。
 *
 * @module src/app/[locale]/(dashboard)/profile/client
 * @author Development Team
 * @since CHANGE-049 - User Profile Page
 * @lastModified 2026-02-26
 *
 * @related
 *   - src/hooks/use-profile.ts - Profile Hook
 *   - src/app/api/v1/users/me/route.ts - API 端點
 */

'use client'

import * as React from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { useSession, signOut } from 'next-auth/react'
import {
  User,
  Mail,
  Shield,
  Calendar,
  Clock,
  Pencil,
  X,
  Check,
  Loader2,
  Lock,
  Info,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/hooks/use-toast'
import { useProfile, useUpdateProfile, useChangePassword } from '@/hooks/use-profile'
import { LocaleSwitcher } from '@/components/features/locale/LocaleSwitcher'
import { formatShortDate, formatDateTime } from '@/lib/i18n-date'
import type { Locale } from '@/i18n/config'

// ============================================================
// Component
// ============================================================

/**
 * @component ProfileClient
 * @description 個人資料頁面主要內容
 */
export function ProfileClient() {
  const t = useTranslations('profile')
  const locale = useLocale() as Locale
  const { toast } = useToast()
  const { data: session } = useSession()
  // FIX-074: 強制首次改密模式（admin seed / 重設密碼後）
  const mustChangePassword = session?.user?.mustChangePassword ?? false

  // --- Data ---
  const { data: profile, isLoading, error } = useProfile()
  const { mutate: updateProfile, isPending: isUpdating } = useUpdateProfile()
  const { mutate: changePassword, isPending: isChangingPassword } = useChangePassword()

  // --- State ---
  const [isEditing, setIsEditing] = React.useState(false)
  const [editName, setEditName] = React.useState('')
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')

  // --- Handlers ---
  const handleEditStart = () => {
    setEditName(profile?.name || '')
    setIsEditing(true)
  }

  const handleEditCancel = () => {
    setIsEditing(false)
    setEditName('')
  }

  const handleEditSave = () => {
    if (!editName.trim()) return
    updateProfile(
      { name: editName.trim() },
      {
        onSuccess: () => {
          setIsEditing(false)
          toast({
            title: t('basicInfo.updateSuccess'),
            variant: 'default',
          })
        },
        onError: (err) => {
          toast({
            title: t('basicInfo.updateError'),
            description: err.message,
            variant: 'destructive',
          })
        },
      }
    )
  }

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      toast({
        title: t('password.mismatch'),
        variant: 'destructive',
      })
      return
    }
    changePassword(
      { currentPassword, newPassword, confirmPassword },
      {
        onSuccess: () => {
          setCurrentPassword('')
          setNewPassword('')
          setConfirmPassword('')
          toast({
            title: t('password.success'),
            variant: 'default',
          })
          // FIX-074: 強制改密成功後登出並重新登入（確保 JWT 旗標刷新後恢復正常存取）
          if (mustChangePassword) {
            void signOut({ callbackUrl: `/${locale}/auth/login` })
          }
        },
        onError: (err) => {
          toast({
            title: t('password.error'),
            description: err.message,
            variant: 'destructive',
          })
        },
      }
    )
  }

  // --- Loading / Error ---
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !profile) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          {error?.message || 'Failed to load profile'}
        </CardContent>
      </Card>
    )
  }

  // --- Render ---
  return (
    <div className="space-y-6 max-w-3xl">
      {/* FIX-074: 強制首次改密提示 */}
      {mustChangePassword && (
        <Card className="border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20">
          <CardContent className="flex items-start gap-3 py-4">
            <Lock className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-amber-800 dark:text-amber-200">
                {t('forceChange.title')}
              </div>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t('forceChange.description')}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Basic Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            {t('basicInfo.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Name (editable) */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-1">
              <User className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1">
                <div className="text-sm text-muted-foreground">{t('basicInfo.name')}</div>
                {isEditing ? (
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={t('basicInfo.namePlaceholder')}
                      className="h-8 max-w-xs"
                      disabled={isUpdating}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleEditSave()
                        if (e.key === 'Escape') handleEditCancel()
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleEditSave}
                      disabled={isUpdating || !editName.trim()}
                    >
                      {isUpdating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleEditCancel} disabled={isUpdating}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="font-medium">{profile.name || '-'}</div>
                )}
              </div>
            </div>
            {!isEditing && (
              <Button size="sm" variant="outline" onClick={handleEditStart}>
                <Pencil className="h-3 w-3 mr-1" />
                {t('basicInfo.edit')}
              </Button>
            )}
          </div>

          <Separator />

          {/* Email (read-only) */}
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <div className="text-sm text-muted-foreground">{t('basicInfo.email')}</div>
              <div className="font-medium">{profile.email}</div>
            </div>
          </div>

          <Separator />

          {/* Provider (read-only) */}
          <div className="flex items-center gap-3">
            <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <div className="text-sm text-muted-foreground">{t('basicInfo.provider')}</div>
              <div className="font-medium">
                {profile.provider === 'azure-ad'
                  ? t('basicInfo.providerAzureAd')
                  : t('basicInfo.providerLocal')}
              </div>
            </div>
          </div>

          <Separator />

          {/* Member Since (read-only) */}
          <div className="flex items-center gap-3">
            <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <div className="text-sm text-muted-foreground">{t('basicInfo.memberSince')}</div>
              <div className="font-medium">
                {formatShortDate(new Date(profile.createdAt), locale)}
              </div>
            </div>
          </div>

          <Separator />

          {/* Last Login (read-only) */}
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            <div>
              <div className="text-sm text-muted-foreground">{t('basicInfo.lastLogin')}</div>
              <div className="font-medium">
                {profile.lastLoginAt
                  ? formatDateTime(new Date(profile.lastLoginAt), locale)
                  : t('basicInfo.neverLoggedIn')}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Roles & Permissions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t('roles.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Roles */}
          <div>
            <div className="text-sm text-muted-foreground mb-2">{t('roles.rolesLabel')}</div>
            {profile.roles.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {profile.roles.map((role) => (
                  <Badge key={`${role.id}-${role.cityId || 'global'}`} variant="secondary">
                    {role.name}
                    {role.cityName && (
                      <span className="ml-1 text-xs opacity-70">
                        ({role.cityName})
                      </span>
                    )}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('roles.noRoles')}</p>
            )}
          </div>

          <Separator />

          {/* Permissions */}
          <div>
            <div className="text-sm text-muted-foreground mb-2">{t('roles.permissionsLabel')}</div>
            {profile.permissions.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {profile.permissions.map((perm) => (
                  <Badge key={perm} variant="outline" className="text-xs">
                    {perm}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('roles.noPermissions')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Language Preference */}
      <Card>
        <CardHeader>
          <CardTitle>{t('language.title')}</CardTitle>
          <CardDescription>{t('language.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{t('language.label')}</span>
            <LocaleSwitcher showLabel variant="outline" />
          </div>
        </CardContent>
      </Card>

      {/* Change Password (local accounts only) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t('password.title')}
          </CardTitle>
          <CardDescription>{t('password.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {profile.provider === 'azure-ad' ? (
            <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
              <p className="text-sm text-blue-700 dark:text-blue-300">
                {t('password.azureAdNote')}
              </p>
            </div>
          ) : (
            <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
              <div>
                <label className="text-sm font-medium">{t('password.currentPassword')}</label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder={t('password.currentPasswordPlaceholder')}
                  className="mt-1"
                  required
                  disabled={isChangingPassword}
                />
              </div>
              <div>
                <label className="text-sm font-medium">{t('password.newPassword')}</label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('password.newPasswordPlaceholder')}
                  className="mt-1"
                  required
                  minLength={8}
                  disabled={isChangingPassword}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('password.requirements')}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">{t('password.confirmPassword')}</label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t('password.confirmPasswordPlaceholder')}
                  className="mt-1"
                  required
                  disabled={isChangingPassword}
                />
              </div>
              <Button type="submit" disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}>
                {isChangingPassword && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {t('password.submit')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Key,
  KeyRound,
  Layers3,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  PenLine,
  Plus,
  Search,
  ShieldCheck,
  Save,
  Trash2,
  UsersRound,
  Box,
  Power,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  archiveAccessToken,
  deleteAccessGroup,
  getAccessSummary,
  getAccessTokenSecret,
  getCurrentBillingRule,
  hardDeleteAccessToken,
  issueAccessToken,
  issueAccessTokensBatch,
  listAccessGroupOptions,
  listAccessGroups,
  listAccessTokens,
  listModels,
  renameAccessGroup,
  saveAccessGroup,
  setAccessGroupEnabled,
  setAccessTokenStatus,
  updateTokenMachineLimits,
  updateTokenMachineLimitsBulk,
  type AccessTokenView,
  type AccessGroup,
  type BatchIssuedAccessTokens,
  type IssuedAccessToken,
  type SaveAccessGroupBody,
} from '@/lib/api/admin'
import {
  currentLocaleTag,
  t as translateStatic,
  useTranslation,
  type TranslationKey,
} from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfigDrawer } from '@/components/config-drawer'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

const emptyGroup = (): SaveAccessGroupBody => ({
  displayName: '',
  enabled: true,
  models: [],
  modelMultipliers: {},
})

export function AccessGroupsPage() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [groupPage, setGroupPage] = useState(1)
  const [groupSearchInput, setGroupSearchInput] = useState('')
  const [groupKeyword, setGroupKeyword] = useState('')
  const [groupEnabled, setGroupEnabled] = useState<
    'all' | 'enabled' | 'disabled'
  >('all')
  const [tokenPage, setTokenPage] = useState(1)
  const [tokenSearchInput, setTokenSearchInput] = useState('')
  const [tokenKeyword, setTokenKeyword] = useState('')
  const [tokenGroupId, setTokenGroupId] = useState('all')
  const [tokenStatus, setTokenStatus] = useState('all')
  const [deviceStatus, setDeviceStatus] = useState('all')
  const groups = useQuery({
    queryKey: ['admin-access-groups', groupPage, groupKeyword, groupEnabled],
    queryFn: () =>
      listAccessGroups(
        groupPage,
        8,
        groupKeyword || undefined,
        groupEnabled === 'all' ? undefined : groupEnabled === 'enabled'
      ),
  })
  const groupOptions = useQuery({
    queryKey: ['admin-access-group-options'],
    queryFn: listAccessGroupOptions,
  })
  const models = useQuery({ queryKey: ['admin-models'], queryFn: listModels })
  const billingRule = useQuery({
    queryKey: ['admin-billing-rule-current'],
    queryFn: getCurrentBillingRule,
  })
  const summary = useQuery({
    queryKey: ['admin-access-summary'],
    queryFn: getAccessSummary,
  })
  const activeGroupId =
    tokenGroupId !== 'all'
      ? tokenGroupId
      : groups.data?.items[0]
        ? String(groups.data.items[0].id)
        : 'all'
  const accessTokens = useQuery({
    queryKey: [
      'admin-access-tokens',
      tokenPage,
      tokenKeyword,
      activeGroupId,
      tokenStatus,
      deviceStatus,
    ],
    queryFn: () =>
      listAccessTokens({
        page: tokenPage,
        pageSize: 10,
        keyword: tokenKeyword || undefined,
        groupId: activeGroupId === 'all' ? undefined : Number(activeGroupId),
        status: tokenStatus as
          | 'all'
          | 'ACTIVE'
          | 'DISABLED'
          | 'REVOKED'
          | 'ARCHIVED',
        deviceStatus: deviceStatus as 'all' | 'unbound' | 'bound' | 'limit',
      }),
    enabled: activeGroupId !== 'all',
  })
  const [editing, setEditing] = useState<AccessGroup | null | undefined>()
  const [renaming, setRenaming] = useState<AccessGroup | null>(null)
  const [permissionGroup, setPermissionGroup] = useState<AccessGroup | null>(
    null
  )
  const [issuingToken, setIssuingToken] = useState<'single' | 'batch' | null>(
    null
  )
  const [selectedTokens, setSelectedTokens] = useState<Set<number>>(new Set())
  const [bulkBindings, setBulkBindings] = useState(2)
  const [bulkUnbinds, setBulkUnbinds] = useState(2)

  const selectedGroup = (groupOptions.data ?? []).find(
    (group) => String(group.id) === activeGroupId
  )

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['admin-access-groups'] }),
      client.invalidateQueries({ queryKey: ['admin-access-group-options'] }),
      client.invalidateQueries({ queryKey: ['admin-access-summary'] }),
    ])
  }
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      setAccessGroupEnabled(id, enabled),
    onSuccess: (_, variables) => {
      toast.success(
        t(
          variables.enabled
            ? 'accessGroups.toast.groupEnabled'
            : 'accessGroups.toast.groupDisabled'
        )
      )
      void refresh()
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
    },
    onError: showError,
  })
  const remove = useMutation({
    mutationFn: deleteAccessGroup,
    onSuccess: (_, deletedGroupId) => {
      toast.success(t('accessGroups.toast.groupDeleted'))
      if (tokenGroupId === String(deletedGroupId)) setTokenGroupId('all')
      if (groups.data?.items.length === 1 && groupPage > 1) {
        setGroupPage((current) => current - 1)
      }
      void refresh()
    },
    onError: showError,
  })
  const bulkLimits = useMutation({
    mutationFn: () =>
      updateTokenMachineLimitsBulk(
        [...selectedTokens],
        bulkBindings,
        bulkUnbinds
      ),
    onSuccess: (result) => {
      toast.success(
        t('accessGroups.toast.bulkLimitsUpdated', { count: result.updated })
      )
      setSelectedTokens(new Set())
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
    },
    onError: showError,
  })
  const currentTokenIds =
    accessTokens.data?.items
      .filter(
        (token) => token.status === 'ACTIVE' || token.status === 'DISABLED'
      )
      .map((token) => token.id) ?? []
  const selectedOnPage = currentTokenIds.filter((id) => selectedTokens.has(id))
  const allCurrentTokensSelected =
    currentTokenIds.length > 0 &&
    selectedOnPage.length === currentTokenIds.length

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <LanguageSwitch />
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main className='max-w-none'>
        <div className='mb-6 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>
              {t('accessGroups.title')}
            </h1>
            <p className='text-muted-foreground'>
              {t('accessGroups.subtitle')}
            </p>
          </div>
          <div className='flex gap-2'>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='outline'>
                  <KeyRound />
                  {t('accessGroups.issue.trigger')}
                  <ChevronDown className='size-4' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-72 p-1.5'>
                <DropdownMenuItem
                  className='items-start gap-3 p-3'
                  onSelect={() => setIssuingToken('single')}
                >
                  <KeyRound className='mt-0.5 size-4' />
                  <span>
                    <span className='block font-medium'>
                      {t('accessGroups.issue.single.title')}
                    </span>
                    <span className='block text-xs text-muted-foreground'>
                      {t('accessGroups.issue.single.desc')}
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className='items-start gap-3 p-3'
                  onSelect={() => setIssuingToken('batch')}
                >
                  <Layers3 className='mt-0.5 size-4' />
                  <span>
                    <span className='block font-medium'>
                      {t('accessGroups.issue.batch.title')}
                    </span>
                    <span className='block text-xs text-muted-foreground'>
                      {t('accessGroups.issue.batch.desc')}
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setEditing(null)}>
              <Plus />
              {t('accessGroups.createGroup')}
            </Button>
          </div>
        </div>

        <div className='mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <AccessSummaryCard
            icon={UsersRound}
            label={t('accessGroups.summary.groupTotal')}
            value={summary.data?.groupTotal}
            detail={t('accessGroups.summary.groupTotalDetail')}
          />
          <AccessSummaryCard
            icon={Key}
            label={t('accessGroups.summary.tokenTotal')}
            value={summary.data?.tokenTotal}
            detail={t('accessGroups.summary.tokenTotalDetail')}
          />
          <AccessSummaryCard
            icon={Box}
            label={t('accessGroups.summary.enabledGroups')}
            value={summary.data?.enabledGroupTotal}
            detail={t('accessGroups.summary.enabledGroupsDetail', {
              count: summary.data?.groupTotal ?? '—',
            })}
          />
          <AccessSummaryCard
            icon={Power}
            label={t('accessGroups.summary.activeTokens')}
            value={summary.data?.activeTokenTotal}
            detail={t('accessGroups.summary.activeTokensDetail', {
              count: summary.data?.tokenTotal ?? '—',
            })}
          />
        </div>

        <div className='grid items-start gap-4 xl:grid-cols-[430px_minmax(0,1fr)]'>
          <Card className='flex min-h-[680px] min-w-0 flex-col overflow-hidden xl:h-[calc(100vh-17rem)]'>
            <div className='space-y-3 border-b p-4'>
              <h2 className='font-semibold'>
                {t('accessGroups.groupList.heading', {
                  count: summary.data?.groupTotal ?? '—',
                })}
              </h2>
              <form
                className='relative'
                onSubmit={(event) => {
                  event.preventDefault()
                  setGroupKeyword(groupSearchInput.trim())
                  setGroupPage(1)
                  setTokenGroupId('all')
                  setTokenPage(1)
                  setSelectedTokens(new Set())
                }}
              >
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  className='pl-9'
                  value={groupSearchInput}
                  onChange={(event) => setGroupSearchInput(event.target.value)}
                  placeholder={t('accessGroups.groupList.searchPlaceholder')}
                />
              </form>
              <div className='flex gap-2'>
                {(
                  [
                    ['all', t('common.state.all'), summary.data?.groupTotal],
                    [
                      'enabled',
                      t('accessGroups.groupList.filterEnabled'),
                      summary.data?.enabledGroupTotal,
                    ],
                    [
                      'disabled',
                      t('accessGroups.groupList.filterDisabled'),
                      summary.data
                        ? summary.data.groupTotal -
                          summary.data.enabledGroupTotal
                        : undefined,
                    ],
                  ] as const
                ).map(([value, label, count]) => (
                  <Button
                    key={value}
                    type='button'
                    size='sm'
                    variant={groupEnabled === value ? 'default' : 'outline'}
                    onClick={() => {
                      setGroupEnabled(value)
                      setGroupPage(1)
                      setTokenGroupId('all')
                      setTokenPage(1)
                      setSelectedTokens(new Set())
                    }}
                  >
                    {label}
                    <span className='tabular-nums opacity-70'>
                      {count ?? '—'}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
            <CardContent className='min-h-0 flex-1 overflow-auto p-0'>
              {groups.isLoading ? (
                <div className='flex h-48 items-center justify-center'>
                  <Loader2 className='animate-spin' />
                </div>
              ) : groups.isError ? (
                <div className='p-8 text-center text-destructive'>
                  {message(groups.error)}
                </div>
              ) : !groups.data?.items.length ? (
                <div className='p-12 text-center text-muted-foreground'>
                  {t('accessGroups.groupList.empty')}
                </div>
              ) : (
                <Table className='min-w-[430px]'>
                  <TableHeader className='sticky top-0 z-10 bg-background'>
                    <TableRow>
                      <TableHead>
                        {t('accessGroups.groupList.columns.name')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.groupList.columns.permission')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.groupList.columns.multiplier')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.groupList.columns.modelCount')}
                      </TableHead>
                      <TableHead className='w-12' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.data.items.map((group) => {
                      const active = String(group.id) === activeGroupId
                      return (
                        <TableRow
                          key={group.id}
                          data-state={active ? 'selected' : undefined}
                          className='cursor-pointer'
                          onClick={() => {
                            setTokenGroupId(String(group.id))
                            setTokenPage(1)
                            setSelectedTokens(new Set())
                          }}
                        >
                          <TableCell>
                            <div className='font-medium'>
                              {group.displayName}
                            </div>
                            <div
                              className={
                                group.enabled
                                  ? 'text-xs text-emerald-600'
                                  : 'text-xs text-muted-foreground'
                              }
                            >
                              {t(
                                group.enabled
                                  ? 'accessGroups.groupList.statusEnabled'
                                  : 'accessGroups.groupList.statusDisabled'
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant='secondary'>
                              {t('accessGroups.groupList.specifiedModels')}
                            </Badge>
                          </TableCell>
                          <TableCell className='font-medium whitespace-nowrap'>
                            {modelMultiplierRange(group)}
                          </TableCell>
                          <TableCell>{group.modelCount}</TableCell>
                          <TableCell
                            onClick={(event) => event.stopPropagation()}
                          >
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size='icon'
                                  variant='ghost'
                                  aria-label={t(
                                    'accessGroups.groupList.rowActions',
                                    { name: group.displayName }
                                  )}
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align='end'>
                                <DropdownMenuItem
                                  onSelect={() => setPermissionGroup(group)}
                                >
                                  <ShieldCheck />
                                  {t('accessGroups.groupList.menu.permissions')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => setRenaming(group)}
                                >
                                  <PenLine />
                                  {t('accessGroups.groupList.menu.rename')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => setEditing(group)}
                                >
                                  <Pencil />
                                  {t('accessGroups.groupList.menu.edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    toggle.mutate({
                                      id: group.id,
                                      enabled: !group.enabled,
                                    })
                                  }
                                >
                                  {group.enabled ? <Ban /> : <Power />}
                                  {t(
                                    group.enabled
                                      ? 'accessGroups.groupList.menu.disable'
                                      : 'accessGroups.groupList.menu.enable'
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className='text-destructive focus:text-destructive'
                                  onSelect={() => {
                                    if (
                                      window.confirm(
                                        t(
                                          'accessGroups.groupList.confirmDelete',
                                          { name: group.displayName }
                                        )
                                      )
                                    )
                                      remove.mutate(group.id)
                                  }}
                                >
                                  <Trash2 />
                                  {t('accessGroups.groupList.menu.delete')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
            {groups.data && groups.data.total > 0 && (
              <ListPagination
                page={groupPage}
                totalPages={groups.data.totalPages}
                total={groups.data.total}
                totalKey='accessGroups.pagination.groupsTotal'
                onPageChange={setGroupPage}
                compact
              />
            )}
          </Card>

          <Card className='flex min-h-[680px] min-w-0 flex-col overflow-hidden xl:h-[calc(100vh-17rem)]'>
            <div className='space-y-4 border-b p-4'>
              <div>
                <h2 className='font-semibold'>
                  {t('accessGroups.tokenPanel.heading')}
                </h2>
                {selectedGroup ? (
                  <div className='mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/45 px-3 py-2.5 text-sm'>
                    <strong>{selectedGroup.displayName}</strong>
                    <Badge
                      variant={selectedGroup.enabled ? 'default' : 'secondary'}
                    >
                      {t(
                        selectedGroup.enabled
                          ? 'accessGroups.groupList.filterEnabled'
                          : 'accessGroups.groupList.filterDisabled'
                      )}
                    </Badge>
                    <span className='text-muted-foreground'>
                      {t('accessGroups.tokenPanel.groupModelCount', {
                        count: selectedGroup.modelCount,
                      })}
                    </span>
                    <span className='text-muted-foreground'>
                      {t('accessGroups.tokenPanel.groupMultiplier', {
                        range: modelMultiplierRange(selectedGroup),
                      })}
                    </span>
                    <span className='text-muted-foreground'>
                      {t('accessGroups.tokenPanel.groupImmutable')}
                    </span>
                  </div>
                ) : (
                  <p className='mt-1 text-sm text-muted-foreground'>
                    {t('accessGroups.tokenPanel.selectGroupHint')}
                  </p>
                )}
              </div>
              <div className='grid gap-2 lg:grid-cols-[minmax(220px,1fr)_150px_150px]'>
                <form
                  className='relative'
                  onSubmit={(event) => {
                    event.preventDefault()
                    setTokenKeyword(tokenSearchInput.trim())
                    setTokenPage(1)
                    setSelectedTokens(new Set())
                  }}
                >
                  <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    className='pl-9'
                    value={tokenSearchInput}
                    onChange={(event) =>
                      setTokenSearchInput(event.target.value)
                    }
                    placeholder={t('accessGroups.tokenPanel.searchPlaceholder')}
                  />
                </form>
                <FilterSelect
                  ariaLabel={t('accessGroups.tokenPanel.statusFilter.label')}
                  value={tokenStatus}
                  onChange={(value) => {
                    setTokenStatus(value)
                    setTokenPage(1)
                    setSelectedTokens(new Set())
                  }}
                  options={[
                    ['all', t('accessGroups.tokenPanel.statusFilter.all')],
                    [
                      'ACTIVE',
                      t('accessGroups.tokenPanel.statusFilter.active'),
                    ],
                    [
                      'DISABLED',
                      t('accessGroups.tokenPanel.statusFilter.disabled'),
                    ],
                    [
                      'REVOKED',
                      t('accessGroups.tokenPanel.statusFilter.revoked'),
                    ],
                    [
                      'ARCHIVED',
                      t('accessGroups.tokenPanel.statusFilter.archived'),
                    ],
                  ]}
                />
                <FilterSelect
                  ariaLabel={t('accessGroups.tokenPanel.deviceFilter.label')}
                  value={deviceStatus}
                  onChange={(value) => {
                    setDeviceStatus(value)
                    setTokenPage(1)
                    setSelectedTokens(new Set())
                  }}
                  options={[
                    ['all', t('accessGroups.tokenPanel.deviceFilter.all')],
                    [
                      'unbound',
                      t('accessGroups.tokenPanel.deviceFilter.unbound'),
                    ],
                    ['bound', t('accessGroups.tokenPanel.deviceFilter.bound')],
                    ['limit', t('accessGroups.tokenPanel.deviceFilter.limit')],
                  ]}
                />
              </div>
              <div className='flex flex-wrap items-end justify-between gap-3 rounded-lg bg-muted/45 px-3 py-2.5'>
                <div className='text-sm font-medium'>
                  {t('accessGroups.tokenPanel.selectedCount', {
                    count: selectedTokens.size,
                  })}
                </div>
                <div className='flex flex-wrap items-end gap-2'>
                  <CompactNumber
                    label={t('accessGroups.tokenPanel.bulkBindings')}
                    value={bulkBindings}
                    onChange={setBulkBindings}
                  />
                  <CompactNumber
                    label={t('accessGroups.tokenPanel.bulkUnbinds')}
                    value={bulkUnbinds}
                    onChange={setBulkUnbinds}
                  />
                  <Button
                    size='sm'
                    disabled={!selectedTokens.size || bulkLimits.isPending}
                    onClick={() => bulkLimits.mutate()}
                  >
                    {t('accessGroups.tokenPanel.applyToSelected', {
                      count: selectedTokens.size,
                    })}
                  </Button>
                </div>
              </div>
            </div>
            {activeGroupId === 'all' ? (
              <div className='flex flex-1 items-center justify-center text-sm text-muted-foreground'>
                {t('accessGroups.tokenPanel.selectGroupEmpty')}
              </div>
            ) : accessTokens.isLoading ? (
              <div className='flex h-32 items-center justify-center'>
                <Loader2 className='animate-spin' />
              </div>
            ) : accessTokens.isError ? (
              <div className='p-8 text-center text-destructive'>
                {message(accessTokens.error)}
              </div>
            ) : (
              <div className='min-h-0 flex-1 overflow-auto'>
                <Table className='min-w-[1050px]'>
                  <TableHeader className='sticky top-0 z-10 bg-background'>
                    <TableRow>
                      <TableHead className='w-10'>
                        <Checkbox
                          aria-label={t(
                            'accessGroups.tokenPanel.selectAllOnPage'
                          )}
                          title={t('accessGroups.tokenPanel.selectAllOnPage')}
                          checked={
                            allCurrentTokensSelected
                              ? true
                              : selectedOnPage.length
                                ? 'indeterminate'
                                : false
                          }
                          onCheckedChange={(checked) => {
                            const next = new Set(selectedTokens)
                            currentTokenIds.forEach((id) => {
                              if (checked) next.add(id)
                              else next.delete(id)
                            })
                            setSelectedTokens(next)
                          }}
                        />
                      </TableHead>
                      <TableHead className='min-w-64'>Token</TableHead>
                      <TableHead>
                        {t('accessGroups.tokenPanel.columns.status')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.tokenPanel.columns.boundDevices')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.tokenPanel.columns.bindLimit')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.tokenPanel.columns.remainingUnbinds')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.tokenPanel.columns.unbindLimit')}
                      </TableHead>
                      <TableHead>
                        {t('accessGroups.tokenPanel.columns.lastUsed')}
                      </TableHead>
                      <TableHead className='text-right'>
                        {t('accessGroups.tokenPanel.columns.actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accessTokens.data?.items.map((token) => (
                      <TokenLimitsRow
                        key={`${token.id}-${token.maxMachineBindings}-${token.maxUnbindCount}`}
                        token={token}
                        selected={selectedTokens.has(token.id)}
                        onReissue={() => setIssuingToken('single')}
                        onSelected={(selected) => {
                          const next = new Set(selectedTokens)
                          if (selected) next.add(token.id)
                          else next.delete(token.id)
                          setSelectedTokens(next)
                        }}
                      />
                    ))}
                    {!accessTokens.data?.items.length && (
                      <TableRow>
                        <TableCell colSpan={9} className='h-28 text-center'>
                          {t('accessGroups.tokenPanel.empty')}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
            {accessTokens.data && accessTokens.data.total > 0 && (
              <ListPagination
                page={tokenPage}
                totalPages={accessTokens.data.totalPages}
                total={accessTokens.data.total}
                totalKey='accessGroups.pagination.tokensTotal'
                onPageChange={setTokenPage}
              />
            )}
          </Card>
        </div>
      </Main>

      {editing !== undefined && (
        <GroupDialog
          key={editing?.id ?? 'new'}
          group={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            void refresh()
          }}
        />
      )}
      {renaming && (
        <RenameGroupDialog
          key={`rename-${renaming.id}`}
          group={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null)
            void refresh()
            void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
          }}
        />
      )}
      {permissionGroup && (
        <PermissionSheet
          key={permissionGroup.id}
          group={permissionGroup}
          models={models.data ?? []}
          onClose={() => setPermissionGroup(null)}
          onSaved={() => {
            setPermissionGroup(null)
            void refresh()
          }}
        />
      )}
      {issuingToken === 'single' && (
        <IssueTokenSheet
          groups={groupOptions.data ?? []}
          pointsPerUsd={billingRule.data?.pointsPerUsd}
          onClose={() => setIssuingToken(null)}
        />
      )}
      {issuingToken === 'batch' && (
        <BatchIssueTokenSheet
          groups={groupOptions.data ?? []}
          onClose={() => setIssuingToken(null)}
        />
      )}
    </>
  )
}

function TokenLimitsRow({
  token,
  selected,
  onReissue,
  onSelected,
}: {
  token: AccessTokenView
  selected: boolean
  onReissue: () => void
  onSelected: (selected: boolean) => void
}) {
  const { t, localeTag } = useTranslation()
  const client = useQueryClient()
  const [maxBindings, setMaxBindings] = useState(token.maxMachineBindings)
  const [maxUnbinds, setMaxUnbinds] = useState(token.maxUnbindCount)
  const [secretOpen, setSecretOpen] = useState(false)
  const [fullToken, setFullToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pendingAction, setPendingAction] = useState<
    'ENABLE' | 'DISABLE' | 'REVOKE' | 'ARCHIVE' | 'DELETE' | null
  >(null)
  const reveal = useMutation({
    mutationFn: () => getAccessTokenSecret(token.id),
    onSuccess: (result) => setFullToken(result.token),
    onError: showError,
  })
  const save = useMutation({
    mutationFn: () =>
      updateTokenMachineLimits(token.id, maxBindings, maxUnbinds),
    onSuccess: () => {
      toast.success(
        t('accessGroups.toast.tokenLimitsUpdated', { label: token.label })
      )
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
    },
    onError: showError,
  })
  const changeStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'DISABLED' | 'REVOKED') =>
      setAccessTokenStatus(token.id, status),
    onSuccess: (_, status) => {
      setPendingAction(null)
      toast.success(
        t(
          status === 'ACTIVE'
            ? 'accessGroups.toast.tokenEnabled'
            : status === 'DISABLED'
              ? 'accessGroups.toast.tokenDisabled'
              : 'accessGroups.toast.tokenRevoked'
        )
      )
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
      void client.invalidateQueries({ queryKey: ['admin-access-summary'] })
    },
    onError: showError,
  })
  const archive = useMutation({
    mutationFn: () => archiveAccessToken(token.id),
    onSuccess: () => {
      setPendingAction(null)
      toast.success(t('accessGroups.toast.tokenArchived'))
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
      void client.invalidateQueries({ queryKey: ['admin-access-summary'] })
    },
    onError: showError,
  })
  const hardDelete = useMutation({
    mutationFn: () => hardDeleteAccessToken(token.id),
    onSuccess: () => {
      setPendingAction(null)
      toast.success(t('accessGroups.toast.tokenHardDeleted'))
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
      void client.invalidateQueries({ queryKey: ['admin-access-summary'] })
    },
    onError: showError,
  })
  const immutable = token.status === 'REVOKED' || token.status === 'ARCHIVED'
  return (
    <>
      <TableRow>
        <TableCell>
          <Checkbox
            checked={selected}
            disabled={immutable}
            onCheckedChange={(v) => onSelected(!!v)}
          />
        </TableCell>
        <TableCell>
          <div className='font-medium'>{token.label}</div>
          {token.status === 'ARCHIVED' ? (
            <span className='block max-w-64 truncate font-mono text-xs text-muted-foreground'>
              {token.prefix}…
            </span>
          ) : (
            <button
              type='button'
              className='block max-w-64 truncate font-mono text-xs text-primary underline-offset-4 hover:underline focus-visible:underline'
              title={t('accessGroups.secret.viewFull')}
              onClick={() => {
                setSecretOpen(true)
                setFullToken(null)
                setCopied(false)
                reveal.mutate()
              }}
            >
              {token.prefix}…
            </button>
          )}
        </TableCell>
        <TableCell>
          <Badge variant={token.status === 'ACTIVE' ? 'default' : 'secondary'}>
            {t(tokenStatusLabelKey(token.status))}
          </Badge>
        </TableCell>
        <TableCell>{token.boundMachineCount}</TableCell>
        <TableCell>
          <Input
            className='h-8 w-20'
            type='number'
            min={0}
            value={maxBindings}
            disabled={immutable}
            onChange={(e) =>
              setMaxBindings(Math.max(0, Number(e.target.value)))
            }
          />
        </TableCell>
        <TableCell>{token.remainingUnbindCount}</TableCell>
        <TableCell>
          <Input
            className='h-8 w-20'
            type='number'
            min={0}
            value={maxUnbinds}
            disabled={immutable}
            onChange={(e) => setMaxUnbinds(Math.max(0, Number(e.target.value)))}
          />
        </TableCell>
        <TableCell className='text-sm whitespace-nowrap text-muted-foreground'>
          {token.lastUsedAt
            ? formatShortDate(token.lastUsedAt, localeTag)
            : t('accessGroups.tokenPanel.neverUsed')}
        </TableCell>
        <TableCell className='text-right'>
          <div className='flex justify-end gap-1'>
            <Button
              size='sm'
              variant='ghost'
              disabled={save.isPending || immutable}
              onClick={() => save.mutate()}
            >
              <Save /> {t('common.action.save')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size='icon'
                  variant='ghost'
                  aria-label={t('accessGroups.tokenPanel.rowActions')}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                {token.status === 'ACTIVE' && (
                  <DropdownMenuItem
                    onSelect={() => setPendingAction('DISABLE')}
                  >
                    <Ban /> {t('accessGroups.tokenPanel.menu.disable')}
                  </DropdownMenuItem>
                )}
                {token.status === 'DISABLED' && (
                  <DropdownMenuItem onSelect={() => setPendingAction('ENABLE')}>
                    <KeyRound /> {t('accessGroups.tokenPanel.menu.enable')}
                  </DropdownMenuItem>
                )}
                {(token.status === 'ACTIVE' || token.status === 'DISABLED') && (
                  <DropdownMenuItem
                    className='text-destructive focus:text-destructive'
                    onSelect={() => setPendingAction('REVOKE')}
                  >
                    <Ban /> {t('accessGroups.tokenPanel.menu.revoke')}
                  </DropdownMenuItem>
                )}
                {token.status !== 'ARCHIVED' && (
                  <DropdownMenuItem
                    onSelect={() => setPendingAction('ARCHIVE')}
                  >
                    <Archive /> {t('accessGroups.tokenPanel.menu.archive')}
                  </DropdownMenuItem>
                )}
                {token.canHardDelete && (
                  <DropdownMenuItem
                    className='text-destructive focus:text-destructive'
                    onSelect={() => setPendingAction('DELETE')}
                  >
                    <Trash2 /> {t('accessGroups.tokenPanel.menu.hardDelete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>
      <Dialog
        open={secretOpen}
        onOpenChange={(open) => {
          setSecretOpen(open)
          if (!open) {
            setFullToken(null)
            setCopied(false)
          }
        }}
      >
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>{t('accessGroups.secret.title')}</DialogTitle>
            <DialogDescription>{token.label}</DialogDescription>
          </DialogHeader>
          <div className='flex items-start gap-3 rounded-md bg-muted/55 p-3 text-sm'>
            <LockKeyhole className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
            <div>
              <div className='font-medium'>{token.groupDisplayName}</div>
              <div className='text-xs text-muted-foreground'>
                {t('accessGroups.secret.meta', {
                  count: token.groupModelCount,
                })}
              </div>
            </div>
            <Button
              className='ms-auto shrink-0'
              size='sm'
              variant='ghost'
              onClick={() => {
                setSecretOpen(false)
                onReissue()
              }}
            >
              {t('accessGroups.secret.reissue')}
            </Button>
          </div>
          {reveal.isPending ? (
            <div className='flex h-24 items-center justify-center'>
              <Loader2 className='animate-spin' />
            </div>
          ) : fullToken ? (
            <div className='space-y-3'>
              <div className='rounded-md border bg-muted/40 p-3 font-mono text-sm break-all select-all'>
                {fullToken}
              </div>
              <Button
                className='w-full'
                variant='outline'
                onClick={async () => {
                  await navigator.clipboard.writeText(fullToken)
                  setCopied(true)
                  toast.success(t('accessGroups.toast.tokenCopied'))
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied
                  ? t('common.action.copied')
                  : t('accessGroups.secret.copy')}
              </Button>
            </div>
          ) : (
            <div className='py-8 text-center text-sm text-muted-foreground'>
              {t('accessGroups.secret.unavailable')}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (
            !open &&
            !changeStatus.isPending &&
            !archive.isPending &&
            !hardDelete.isPending
          ) {
            setPendingAction(null)
          }
        }}
        title={t(
          pendingAction === 'ENABLE'
            ? 'accessGroups.confirm.enableTitle'
            : pendingAction === 'DISABLE'
              ? 'accessGroups.confirm.disableTitle'
              : pendingAction === 'REVOKE'
                ? 'accessGroups.confirm.revokeTitle'
                : pendingAction === 'ARCHIVE'
                  ? 'accessGroups.confirm.archiveTitle'
                  : 'accessGroups.confirm.deleteTitle',
          { label: token.label }
        )}
        desc={
          <div className='space-y-2'>
            {pendingAction === 'ENABLE' && (
              <p>{t('accessGroups.confirm.enableDesc')}</p>
            )}
            {pendingAction === 'DISABLE' && (
              <>
                <p>{t('accessGroups.confirm.disableDesc1')}</p>
                <p>{t('accessGroups.confirm.disableDesc2')}</p>
              </>
            )}
            {pendingAction === 'REVOKE' && (
              <>
                <p>{t('accessGroups.confirm.revokeDesc1')}</p>
                <p>{t('accessGroups.confirm.revokeDesc2')}</p>
              </>
            )}
            {pendingAction === 'ARCHIVE' && (
              <>
                <p>{t('accessGroups.confirm.archiveDesc1')}</p>
                <p>{t('accessGroups.confirm.archiveDesc2')}</p>
              </>
            )}
            {pendingAction === 'DELETE' && (
              <>
                <p>{t('accessGroups.confirm.deleteDesc1')}</p>
                <p className='font-medium text-destructive'>
                  {t('accessGroups.confirm.deleteDesc2')}
                </p>
              </>
            )}
          </div>
        }
        cancelBtnText={t('common.action.cancel')}
        confirmText={t(
          pendingAction === 'ENABLE'
            ? 'accessGroups.confirm.enableConfirm'
            : pendingAction === 'DISABLE'
              ? 'accessGroups.confirm.disableConfirm'
              : pendingAction === 'REVOKE'
                ? 'accessGroups.confirm.revokeConfirm'
                : pendingAction === 'ARCHIVE'
                  ? 'accessGroups.confirm.archiveConfirm'
                  : 'accessGroups.confirm.deleteConfirm'
        )}
        destructive={pendingAction === 'REVOKE' || pendingAction === 'DELETE'}
        isLoading={
          changeStatus.isPending || archive.isPending || hardDelete.isPending
        }
        handleConfirm={() => {
          if (pendingAction === 'ENABLE') changeStatus.mutate('ACTIVE')
          if (pendingAction === 'DISABLE') changeStatus.mutate('DISABLED')
          if (pendingAction === 'REVOKE') changeStatus.mutate('REVOKED')
          if (pendingAction === 'ARCHIVE') archive.mutate()
          if (pendingAction === 'DELETE') hardDelete.mutate()
        }}
      />
    </>
  )
}

function ListPagination({
  page,
  totalPages,
  total,
  totalKey,
  onPageChange,
  compact = false,
}: {
  page: number
  totalPages: number
  total: number
  totalKey: TranslationKey
  onPageChange: (page: number) => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='flex min-w-max items-center justify-between gap-4 border-t px-4 py-3 text-sm'>
      <span className='text-muted-foreground'>{t(totalKey, { total })}</span>
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={t('common.pagination.prev')}
        >
          <ChevronLeft />
          {!compact && t('common.pagination.prev')}
        </Button>
        <span className='min-w-16 text-center tabular-nums'>
          {page} / {totalPages}
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label={t('common.pagination.next')}
        >
          {!compact && t('common.pagination.next')}
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}

function AccessSummaryCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon
  label: string
  value?: number
  detail: string
}) {
  const { localeTag } = useTranslation()
  return (
    <Card>
      <CardContent className='flex items-center gap-4 p-4'>
        <span className='flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-black ring-1 ring-black/10 transition-colors dark:bg-black dark:text-white dark:ring-white/15'>
          <Icon className='size-5' />
        </span>
        <div className='min-w-0'>
          <div className='text-sm text-muted-foreground'>{label}</div>
          <div className='text-2xl font-bold tabular-nums'>
            {value == null ? '—' : value.toLocaleString(localeTag)}
          </div>
          <div className='truncate text-xs text-muted-foreground'>{detail}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function FilterSelect({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}) {
  return (
    <select
      aria-label={ariaLabel}
      className='h-10 rounded-md border bg-background px-3 text-sm'
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  )
}

function CompactNumber({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className='grid gap-1 text-xs text-muted-foreground'>
      {label}
      <Input
        className='h-8 w-24 text-foreground'
        type='number'
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
      />
    </label>
  )
}

/** 只改分组名称的轻量弹窗，走 rename 窄接口，不触碰模型权限与倍率。 */
function RenameGroupDialog({
  group,
  onClose,
  onSaved,
}: {
  group: AccessGroup
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState(group.displayName)
  const rename = useMutation({
    mutationFn: (name: string) => renameAccessGroup(group.id, name),
    onSuccess: () => {
      toast.success(t('accessGroups.toast.groupRenamed'))
      onSaved()
    },
    onError: showError,
  })
  const submit = () => {
    const name = displayName.trim()
    if (!name)
      return toast.error(t('accessGroups.validation.groupNameRequired'))
    if (name.length > 128)
      return toast.error(t('accessGroups.validation.groupNameTooLong'))
    if (name === group.displayName) return onClose()
    rename.mutate(name)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('accessGroups.rename.title')}</DialogTitle>
          <DialogDescription>{t('accessGroups.rename.desc')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 py-2'>
          <Field label={t('accessGroups.rename.nameLabel')}>
            <Input
              autoFocus
              value={displayName}
              maxLength={128}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && submit()}
              placeholder={t('accessGroups.rename.namePlaceholder')}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            {t('common.action.cancel')}
          </Button>
          <Button onClick={submit} disabled={rename.isPending}>
            {rename.isPending && <Loader2 className='animate-spin' />}
            {t('accessGroups.rename.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GroupDialog({
  group,
  onClose,
  onSaved,
}: {
  group: AccessGroup | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState(() =>
    group ? fromGroup(group) : emptyGroup()
  )
  const save = useMutation({
    // 编辑已有分组时改走两个窄接口：saveAccessGroup 是全量覆盖，会用弹窗打开那一刻的
    // 模型权限快照回写数据库，可能把别处刚保存的权限覆盖掉。新建时才需要全量提交。
    mutationFn: async (body: SaveAccessGroupBody) => {
      if (!group) return saveAccessGroup(body)
      if (body.displayName !== group.displayName) {
        await renameAccessGroup(group.id, body.displayName)
      }
      if (body.enabled !== group.enabled) {
        await setAccessGroupEnabled(group.id, body.enabled)
      }
    },
    onSuccess: () => {
      toast.success(
        t(
          group
            ? 'accessGroups.toast.groupUpdated'
            : 'accessGroups.toast.groupCreated'
        )
      )
      onSaved()
    },
    onError: showError,
  })
  const submit = () => {
    const displayName = form.displayName.trim()
    if (!displayName)
      return toast.error(t('accessGroups.validation.groupNameRequired'))
    if (displayName.length > 128)
      return toast.error(t('accessGroups.validation.groupNameTooLong'))
    save.mutate({ ...form, displayName })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              group
                ? 'accessGroups.dialog.editTitle'
                : 'accessGroups.dialog.createTitle'
            )}
          </DialogTitle>
          <DialogDescription>{t('accessGroups.dialog.desc')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 py-2'>
          <Field label={t('accessGroups.dialog.nameLabel')}>
            <Input
              value={form.displayName}
              maxLength={128}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
              placeholder={t('accessGroups.dialog.namePlaceholder')}
            />
          </Field>
          <Toggle
            label={t('accessGroups.dialog.enableLabel')}
            description={t('accessGroups.dialog.enableDesc')}
            checked={form.enabled}
            onCheckedChange={(checked) =>
              setForm({ ...form, enabled: checked })
            }
          />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            {t('common.action.cancel')}
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className='animate-spin' />}
            {t('common.action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PermissionSheet({
  group,
  models,
  onClose,
  onSaved,
}: {
  group: AccessGroup
  models: Awaited<ReturnType<typeof listModels>>
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(group.modelIds)
  )
  const [modelMultipliers, setModelMultipliers] = useState<
    Record<string, number | string>
  >(() => ({ ...group.modelMultipliers }))
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const visible = models.filter(
    (model) =>
      !query ||
      model.modelId.toLowerCase().includes(query) ||
      model.displayName.toLowerCase().includes(query)
  )
  const save = useMutation({
    mutationFn: saveAccessGroup,
    onSuccess: () => {
      toast.success(t('accessGroups.toast.permissionsUpdated'))
      onSaved()
    },
    onError: showError,
  })
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className='sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>
            {t('accessGroups.permission.title', { name: group.displayName })}
          </SheetTitle>
          <SheetDescription>
            {t('accessGroups.permission.desc')}
          </SheetDescription>
        </SheetHeader>
        <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4'>
          <div className='relative'>
            <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
            <Input
              className='pl-9'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('accessGroups.permission.searchPlaceholder')}
            />
          </div>
          <div className='flex items-center justify-between text-sm text-muted-foreground'>
            <span>
              {t('accessGroups.permission.selectedCount', {
                count: selected.size,
              })}
            </span>
            <div className='flex gap-2'>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  const enabledIds = models
                    .filter((model) => model.enabled)
                    .map((model) => model.modelId)
                  setSelected(new Set(enabledIds))
                  setModelMultipliers((current) => ({
                    ...Object.fromEntries(enabledIds.map((id) => [id, 1])),
                    ...current,
                  }))
                }}
              >
                {t('accessGroups.permission.selectAll')}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setSelected(new Set())}
              >
                {t('accessGroups.permission.clear')}
              </Button>
            </div>
          </div>
          <div className='min-h-0 flex-1 space-y-2 overflow-y-auto rounded-md border p-2'>
            {visible.map((model) => (
              <label
                key={model.modelId}
                className='grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_110px] items-center gap-3 rounded-md p-3 hover:bg-muted/60'
              >
                <Checkbox
                  checked={selected.has(model.modelId)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected)
                    if (checked) {
                      next.add(model.modelId)
                      setModelMultipliers((current) => ({
                        ...current,
                        [model.modelId]: current[model.modelId] ?? 1,
                      }))
                    } else next.delete(model.modelId)
                    setSelected(next)
                  }}
                />
                <span className='min-w-0 flex-1'>
                  <span className='block font-medium'>{model.displayName}</span>
                  <span className='block truncate font-mono text-xs text-muted-foreground'>
                    {model.modelId}
                  </span>
                </span>
                {selected.has(model.modelId) ? (
                  <Input
                    aria-label={t('accessGroups.permission.multiplierAria', {
                      name: model.displayName,
                    })}
                    type='text'
                    inputMode='decimal'
                    value={modelMultipliers[model.modelId] ?? ''}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setModelMultipliers((current) => ({
                        ...current,
                        [model.modelId]: event.target.value,
                      }))
                    }
                    placeholder={t(
                      'accessGroups.permission.multiplierPlaceholder'
                    )}
                  />
                ) : !model.enabled ? (
                  <Badge variant='secondary'>
                    {t('common.state.disabled')}
                  </Badge>
                ) : (
                  <span />
                )}
              </label>
            ))}
          </div>
        </div>
        <SheetFooter>
          <Button variant='outline' onClick={onClose}>
            {t('common.action.cancel')}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              const normalized = Object.fromEntries(
                [...selected].map((modelId) => [
                  modelId,
                  Number(modelMultipliers[modelId]),
                ])
              )
              if (
                Object.values(normalized).some(
                  (value) => !Number.isFinite(value) || value <= 0
                )
              )
                return toast.error(
                  t('accessGroups.validation.multiplierPositive')
                )
              save.mutate({
                ...fromGroup(group),
                models: [...selected],
                modelMultipliers: normalized,
              })
            }}
          >
            {save.isPending && <Loader2 className='animate-spin' />}
            {t('accessGroups.permission.submit')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

type ExpiryPreset = 'never' | '7' | '30' | '90' | '365' | 'custom'

function IssueTokenSheet({
  groups,
  pointsPerUsd,
  onClose,
}: {
  groups: AccessGroup[]
  pointsPerUsd?: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const availableGroups = groups.filter((group) => group.enabled)
  const [label, setLabel] = useState('')
  const [groupId, setGroupId] = useState(availableGroups[0]?.id ?? 0)
  const [enabled, setEnabled] = useState(true)
  const [initialPoints, setInitialPoints] = useState('100')
  const [maxMachineBindings, setMaxMachineBindings] = useState(2)
  const [maxUnbindCount, setMaxUnbindCount] = useState(2)
  const [expiry, setExpiry] = useState<ExpiryPreset>('never')
  const [customExpiry, setCustomExpiry] = useState('')
  const [issued, setIssued] = useState<IssuedAccessToken | null>(null)
  const [copied, setCopied] = useState(false)
  const selectedGroup = availableGroups.find((group) => group.id === groupId)
  const mutation = useMutation({
    mutationFn: issueAccessToken,
    onSuccess: async (result) => {
      setIssued(result)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-access-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-access-summary'] }),
      ])
      toast.success(t('accessGroups.toast.tokenIssued'))
    },
    onError: showError,
  })
  const submit = () => {
    const points = Number(initialPoints)
    const expiresAt = expiryValue(expiry, customExpiry)
    if (!label.trim())
      return toast.error(t('accessGroups.validation.tokenLabelRequired'))
    if (!groupId) return toast.error(t('accessGroups.validation.groupRequired'))
    if (!Number.isFinite(points) || points < 0)
      return toast.error(t('accessGroups.validation.pointsNegative'))
    if (expiry === 'custom' && !expiresAt)
      return toast.error(t('accessGroups.validation.customExpiryRequired'))
    if (expiresAt && new Date(expiresAt) <= new Date())
      return toast.error(t('accessGroups.validation.expiryFuture'))
    mutation.mutate({
      label: label.trim(),
      groupId,
      enabled,
      expiresAt,
      initialPoints: points,
      maxMachineBindings,
      maxUnbindCount,
    })
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className='sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>
            {t(
              issued
                ? 'accessGroups.issueSheet.successTitle'
                : 'accessGroups.issueSheet.title'
            )}
          </SheetTitle>
          <SheetDescription>
            {t(
              issued
                ? 'accessGroups.issueSheet.successDesc'
                : 'accessGroups.issueSheet.desc'
            )}
          </SheetDescription>
        </SheetHeader>
        {issued ? (
          <div className='flex-1 space-y-6 overflow-y-auto px-4 pb-4'>
            <div>
              <div className='text-lg font-semibold'>{issued.label}</div>
              <div className='text-sm text-muted-foreground'>
                {selectedGroup?.displayName ?? `#${issued.groupId}`} ·{' '}
                {selectedGroup ? modelMultiplierRange(selectedGroup) : '—'}
              </div>
            </div>
            <div className='grid grid-cols-2 gap-4 border-y py-4 text-sm'>
              <Summary
                label={t('accessGroups.issueSheet.initialPoints')}
                value={formatPoints(issued.initialPoints)}
              />
              <Summary
                label={t('accessGroups.issueSheet.deviceLimit')}
                value={
                  issued.maxMachineBindings === 0
                    ? t('accessGroups.issueSheet.deviceUnlimited')
                    : t('accessGroups.issueSheet.deviceCount', {
                        count: issued.maxMachineBindings,
                      })
                }
              />
            </div>
            <section className='space-y-2'>
              <Label>Access Token</Label>
              <div className='flex items-stretch gap-2'>
                <div className='min-w-0 flex-1 rounded-md border bg-muted/40 p-3 font-mono text-sm break-all select-all'>
                  {issued.token}
                </div>
                <Button
                  variant='outline'
                  size='icon'
                  aria-label={t('accessGroups.issueSheet.copyAria')}
                  onClick={() => void copyText(issued.token, setCopied)}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
              <p className='text-sm font-medium'>
                {t('accessGroups.issueSheet.saveNotice')}
              </p>
            </section>
          </div>
        ) : (
          <div className='flex-1 overflow-y-auto px-4 pb-4'>
            <FormSection title={t('accessGroups.issueSheet.sectionBasic')}>
              <Field label={t('accessGroups.issueSheet.labelField')}>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('accessGroups.issueSheet.labelPlaceholder')}
                />
              </Field>
              <Field label={t('accessGroups.issueSheet.groupField')}>
                <GroupSelect
                  groups={availableGroups}
                  value={groupId}
                  onChange={setGroupId}
                />
              </Field>
              <ImmutableGroupNotice batch={false} />
              {selectedGroup && (
                <div className='grid grid-cols-2 gap-3 rounded-md bg-muted/60 p-3 text-sm'>
                  <Summary
                    label={t('accessGroups.issueSheet.multiplierSummary')}
                    value={modelMultiplierRange(selectedGroup)}
                  />
                  <Summary
                    label={t('accessGroups.issueSheet.permissionSummary')}
                    value={t('accessGroups.issueSheet.modelCountValue', {
                      count: selectedGroup.modelCount,
                    })}
                  />
                </div>
              )}
            </FormSection>
            <FormSection title={t('accessGroups.issueSheet.sectionLimits')}>
              <Toggle
                label={t('accessGroups.issueSheet.enableLabel')}
                description={t('accessGroups.issueSheet.enableDesc')}
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <div className='grid grid-cols-2 gap-3'>
                <Field label={t('accessGroups.issueSheet.bindLimit')}>
                  <Input
                    type='number'
                    min={0}
                    value={maxMachineBindings}
                    onChange={(event) =>
                      setMaxMachineBindings(
                        Math.max(0, Number(event.target.value))
                      )
                    }
                  />
                  <p className='mt-1.5 text-xs text-muted-foreground'>
                    {t('accessGroups.issueSheet.bindLimitHint')}
                  </p>
                </Field>
                <Field label={t('accessGroups.issueSheet.unbindLimit')}>
                  <Input
                    type='number'
                    min={0}
                    value={maxUnbindCount}
                    onChange={(event) =>
                      setMaxUnbindCount(Math.max(0, Number(event.target.value)))
                    }
                  />
                  <p className='mt-1.5 text-xs text-muted-foreground'>
                    {t('accessGroups.issueSheet.unbindLimitHint')}
                  </p>
                </Field>
              </div>
              <ExpiryControl
                expiry={expiry}
                customExpiry={customExpiry}
                onExpiryChange={setExpiry}
                onCustomExpiryChange={setCustomExpiry}
              />
            </FormSection>
            <FormSection title={t('accessGroups.issueSheet.sectionPoints')}>
              <Field label={t('accessGroups.issueSheet.initialPoints')}>
                <Input
                  type='text'
                  inputMode='decimal'
                  value={initialPoints}
                  onChange={(event) => setInitialPoints(event.target.value)}
                />
              </Field>
              <div className='space-y-1 rounded-md bg-muted/60 p-3 text-sm'>
                <div>
                  {t('accessGroups.issueSheet.currentMultiplierLabel')}
                  <strong>
                    {selectedGroup ? modelMultiplierRange(selectedGroup) : '—'}
                  </strong>
                </div>
                <div>
                  {pointsPerUsd == null
                    ? t('accessGroups.issueSheet.baseRuleLoading')
                    : t('accessGroups.issueSheet.baseRule', {
                        points: formatPoints(pointsPerUsd),
                      })}
                </div>
                <div>
                  {t('accessGroups.issueSheet.initialBalanceLabel')}
                  <strong>
                    {t('accessGroups.issueSheet.pointsValue', {
                      points: formatPoints(Number(initialPoints)),
                    })}
                  </strong>
                </div>
              </div>
            </FormSection>
            <FormSection
              title={t('accessGroups.issueSheet.sectionGeneration')}
              last
            >
              <GenerationInfo
                label={t('accessGroups.issueSheet.generationLabel')}
              />
            </FormSection>
          </div>
        )}
        <SheetFooter>
          {issued ? (
            <>
              <Button
                variant='outline'
                onClick={() => void copyText(issued.token, setCopied)}
              >
                <Copy /> {t('accessGroups.secret.copy')}
              </Button>
              <Button onClick={onClose}>
                {t('accessGroups.issueSheet.done')}
              </Button>
            </>
          ) : (
            <>
              <Button variant='outline' onClick={onClose}>
                {t('common.action.cancel')}
              </Button>
              <Button
                disabled={mutation.isPending || !availableGroups.length}
                onClick={submit}
              >
                {mutation.isPending && <Loader2 className='animate-spin' />}
                {t('accessGroups.issueSheet.title')}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function BatchIssueTokenSheet({
  groups,
  onClose,
}: {
  groups: AccessGroup[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const availableGroups = groups.filter((group) => group.enabled)
  const [groupId, setGroupId] = useState(availableGroups[0]?.id ?? 0)
  const [quantity, setQuantity] = useState(100)
  const [labelPrefix, setLabelPrefix] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [initialPoints, setInitialPoints] = useState('100')
  const [maxMachineBindings, setMaxMachineBindings] = useState(2)
  const [maxUnbindCount, setMaxUnbindCount] = useState(2)
  const [expiry, setExpiry] = useState<ExpiryPreset>('never')
  const [customExpiry, setCustomExpiry] = useState('')
  const [issued, setIssued] = useState<BatchIssuedAccessTokens | null>(null)
  const selectedGroup = availableGroups.find((group) => group.id === groupId)
  const points = Number(initialPoints)
  const totalPoints = Number.isFinite(points) ? points * quantity : 0
  const mutation = useMutation({
    mutationFn: issueAccessTokensBatch,
    onSuccess: async (result) => {
      setIssued(result)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-access-tokens'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-access-summary'] }),
      ])
      toast.success(
        t('accessGroups.toast.tokensIssued', { count: result.quantity })
      )
    },
    onError: showError,
  })
  const submit = () => {
    const expiresAt = expiryValue(expiry, customExpiry)
    if (!labelPrefix.trim())
      return toast.error(t('accessGroups.validation.tokenPrefixRequired'))
    if (!groupId) return toast.error(t('accessGroups.validation.groupRequired'))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000)
      return toast.error(t('accessGroups.validation.quantityRange'))
    if (!Number.isFinite(points) || points < 0)
      return toast.error(t('accessGroups.validation.batchPointsNegative'))
    if (expiry === 'custom' && !expiresAt)
      return toast.error(t('accessGroups.validation.customExpiryRequired'))
    if (expiresAt && new Date(expiresAt) <= new Date())
      return toast.error(t('accessGroups.validation.expiryFuture'))
    mutation.mutate({
      labelPrefix: labelPrefix.trim(),
      quantity,
      groupId,
      enabled,
      expiresAt,
      initialPoints: points,
      maxMachineBindings,
      maxUnbindCount,
    })
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className='sm:max-w-3xl'>
        <SheetHeader>
          <SheetTitle>
            {t(
              issued
                ? 'accessGroups.batchSheet.successTitle'
                : 'accessGroups.batchSheet.title'
            )}
          </SheetTitle>
          <SheetDescription>
            {issued
              ? t('accessGroups.batchSheet.successDesc', {
                  count: issued.quantity,
                })
              : t('accessGroups.batchSheet.desc')}
          </SheetDescription>
        </SheetHeader>
        {issued ? (
          <BatchIssueResult
            result={issued}
            group={selectedGroup}
            onDone={onClose}
          />
        ) : (
          <div className='flex-1 overflow-y-auto px-4 pb-4'>
            <FormSection title={t('accessGroups.batchSheet.sectionRules')}>
              <Field label={t('accessGroups.batchSheet.groupField')}>
                <GroupSelect
                  groups={availableGroups}
                  value={groupId}
                  onChange={setGroupId}
                />
              </Field>
              <ImmutableGroupNotice batch />
              <div className='grid grid-cols-[140px_1fr] gap-3'>
                <Field label={t('accessGroups.batchSheet.quantityField')}>
                  <Input
                    type='number'
                    min={1}
                    max={1000}
                    value={quantity}
                    onChange={(event) =>
                      setQuantity(Math.max(1, Number(event.target.value)))
                    }
                  />
                </Field>
                <Field label={t('accessGroups.batchSheet.prefixField')}>
                  <Input
                    value={labelPrefix}
                    onChange={(event) => setLabelPrefix(event.target.value)}
                    placeholder={t('accessGroups.batchSheet.prefixPlaceholder')}
                    maxLength={120}
                  />
                </Field>
              </div>
              <div className='rounded-md bg-muted/55 p-3 text-xs text-muted-foreground'>
                <span className='mb-1 block font-medium text-foreground'>
                  {t('accessGroups.batchSheet.livePreview')}
                </span>
                {batchLabelPreview(
                  labelPrefix,
                  quantity,
                  t('accessGroups.batchSheet.prefixFallback')
                ).map((label) => (
                  <span key={label} className='block font-mono'>
                    {label}
                  </span>
                ))}
              </div>
            </FormSection>
            <FormSection title={t('accessGroups.batchSheet.sectionLimits')}>
              <Toggle
                label={t('accessGroups.batchSheet.enableLabel')}
                description={t('accessGroups.batchSheet.enableDesc')}
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <div className='grid grid-cols-2 gap-3'>
                <Field label={t('accessGroups.batchSheet.bindLimit')}>
                  <Input
                    type='number'
                    min={0}
                    value={maxMachineBindings}
                    onChange={(event) =>
                      setMaxMachineBindings(
                        Math.max(0, Number(event.target.value))
                      )
                    }
                  />
                </Field>
                <Field label={t('accessGroups.batchSheet.unbindLimit')}>
                  <Input
                    type='number'
                    min={0}
                    value={maxUnbindCount}
                    onChange={(event) =>
                      setMaxUnbindCount(Math.max(0, Number(event.target.value)))
                    }
                  />
                </Field>
              </div>
              <ExpiryControl
                expiry={expiry}
                customExpiry={customExpiry}
                onExpiryChange={setExpiry}
                onCustomExpiryChange={setCustomExpiry}
              />
              <p className='text-xs text-muted-foreground'>
                {t('accessGroups.batchSheet.limitsNotice')}
              </p>
            </FormSection>
            <FormSection title={t('accessGroups.batchSheet.sectionPoints')}>
              <Field label={t('accessGroups.batchSheet.pointsField')}>
                <Input
                  type='text'
                  inputMode='decimal'
                  value={initialPoints}
                  onChange={(event) => setInitialPoints(event.target.value)}
                />
              </Field>
              <div className='grid grid-cols-2 gap-3 rounded-md bg-muted/55 p-3 text-sm sm:grid-cols-4'>
                <Summary
                  label={t('accessGroups.batchSheet.quantityField')}
                  value={String(quantity)}
                />
                <Summary
                  label={t('accessGroups.batchSheet.pointsPerToken')}
                  value={formatPoints(points)}
                />
                <Summary
                  label={t('accessGroups.batchSheet.totalPoints')}
                  value={t('accessGroups.batchSheet.totalPointsValue', {
                    points: formatPoints(totalPoints),
                  })}
                />
                <Summary
                  label={t('accessGroups.batchSheet.groupAndMultiplier')}
                  value={`${selectedGroup?.displayName ?? '—'} · ${selectedGroup ? modelMultiplierRange(selectedGroup) : '—'}`}
                />
              </div>
            </FormSection>
            <FormSection
              title={t('accessGroups.batchSheet.sectionGeneration')}
              last
            >
              <GenerationInfo
                label={t('accessGroups.batchSheet.generationLabel')}
              />
            </FormSection>
          </div>
        )}
        {!issued && (
          <SheetFooter className='border-t'>
            <div className='me-auto hidden text-xs text-muted-foreground sm:block'>
              {t('accessGroups.batchSheet.footerSummary', {
                quantity,
                group:
                  selectedGroup?.displayName ??
                  t('accessGroups.batchSheet.footerGroupUnset'),
                points: formatPoints(points),
                total: formatPoints(totalPoints),
                devices:
                  maxMachineBindings === 0
                    ? t('accessGroups.batchSheet.footerDeviceUnlimited')
                    : t('accessGroups.batchSheet.footerDeviceCount', {
                        count: maxMachineBindings,
                      }),
              })}
            </div>
            <Button variant='outline' onClick={onClose}>
              {t('common.action.cancel')}
            </Button>
            <Button
              disabled={mutation.isPending || !availableGroups.length}
              onClick={submit}
            >
              {mutation.isPending && <Loader2 className='animate-spin' />}
              {t('accessGroups.batchSheet.submit', { quantity })}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

function BatchIssueResult({
  result,
  group,
  onDone,
}: {
  result: BatchIssuedAccessTokens
  group?: AccessGroup
  onDone: () => void
}) {
  const { t } = useTranslation()
  const copyAll = () =>
    copyText(
      [
        'Label\tToken',
        ...result.items.map((item) => `${item.label}\t${item.token}`),
      ].join('\n')
    )
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex items-center gap-2 font-medium text-emerald-600'>
          <Check className='size-5' />{' '}
          {t('accessGroups.batchResult.generated', { count: result.quantity })}
        </div>
        <div className='flex gap-2'>
          <Button variant='outline' size='sm' onClick={() => void copyAll()}>
            <Copy /> {t('accessGroups.batchResult.copyAll')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => exportTokensCsv(result.items, group)}
          >
            <Download /> {t('accessGroups.batchResult.exportCsv')}
          </Button>
        </div>
      </div>
      <div className='min-h-0 flex-1 overflow-auto rounded-md border'>
        <Table className='min-w-[760px]'>
          <TableHeader className='sticky top-0 bg-background'>
            <TableRow>
              <TableHead>
                {t('accessGroups.batchResult.columns.label')}
              </TableHead>
              <TableHead>Token</TableHead>
              <TableHead>
                {t('accessGroups.batchResult.columns.group')}
              </TableHead>
              <TableHead>
                {t('accessGroups.batchResult.columns.initialPoints')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.map((item) => (
              <TableRow key={item.token}>
                <TableCell>{item.label}</TableCell>
                <TableCell>
                  <div className='flex max-w-80 items-center gap-2'>
                    <span className='truncate font-mono text-xs'>
                      {item.token}
                    </span>
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-7 shrink-0'
                      aria-label={t('accessGroups.batchResult.copyRow', {
                        label: item.label,
                      })}
                      onClick={() => void copyText(item.token)}
                    >
                      <Copy />
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  {group?.displayName ?? `#${item.groupId}`}
                </TableCell>
                <TableCell>{formatPoints(item.initialPoints)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className='flex justify-end'>
        <Button onClick={onDone}>{t('accessGroups.batchResult.done')}</Button>
      </div>
    </div>
  )
}

function FormSection({
  title,
  children,
  last = false,
}: {
  title: string
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <section className={`space-y-4 py-5 ${last ? '' : 'border-b'}`}>
      <h3 className='font-semibold'>{title}</h3>
      {children}
    </section>
  )
}

function ImmutableGroupNotice({ batch }: { batch: boolean }) {
  const { t } = useTranslation()
  return (
    <div className='flex gap-3 rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/30'>
      <LockKeyhole className='mt-0.5 size-4 shrink-0 text-blue-600' />
      <div>
        <div className='font-medium'>
          {t('accessGroups.notice.immutableTitle')}
        </div>
        <p className='mt-0.5 text-xs text-muted-foreground'>
          {t(
            batch
              ? 'accessGroups.notice.immutableBatch'
              : 'accessGroups.notice.immutableSingle'
          )}
        </p>
      </div>
    </div>
  )
}

function GroupSelect({
  groups,
  value,
  onChange,
}: {
  groups: AccessGroup[]
  value: number
  onChange: (value: number) => void
}) {
  const { t } = useTranslation()
  return (
    <select
      className='h-10 w-full rounded-md border bg-background px-3 text-sm'
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {!groups.length && (
        <option value={0}>{t('accessGroups.groupSelect.empty')}</option>
      )}
      {groups.map((group) => (
        <option key={group.id} value={group.id}>
          {t('accessGroups.groupSelect.option', {
            name: group.displayName,
            range: modelMultiplierRange(group),
            count: group.modelCount,
          })}
        </option>
      ))}
    </select>
  )
}

function ExpiryControl({
  expiry,
  customExpiry,
  onExpiryChange,
  onCustomExpiryChange,
}: {
  expiry: ExpiryPreset
  customExpiry: string
  onExpiryChange: (value: ExpiryPreset) => void
  onCustomExpiryChange: (value: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <Field label={t('accessGroups.expiry.label')}>
        <select
          className='h-10 w-full rounded-md border bg-background px-3 text-sm'
          value={expiry}
          onChange={(event) =>
            onExpiryChange(event.target.value as ExpiryPreset)
          }
        >
          <option value='never'>{t('accessGroups.expiry.never')}</option>
          <option value='7'>{t('accessGroups.expiry.days7')}</option>
          <option value='30'>{t('accessGroups.expiry.days30')}</option>
          <option value='90'>{t('accessGroups.expiry.days90')}</option>
          <option value='365'>{t('accessGroups.expiry.year1')}</option>
          <option value='custom'>{t('accessGroups.expiry.custom')}</option>
        </select>
      </Field>
      {expiry === 'custom' && (
        <Input
          type='datetime-local'
          value={customExpiry}
          onChange={(event) => onCustomExpiryChange(event.target.value)}
        />
      )}
    </>
  )
}

function GenerationInfo({ label }: { label: string }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-3 text-sm'>
      <span className='size-2.5 rounded-full bg-primary' />
      <div>
        <div className='font-medium'>{label}</div>
        <div className='text-xs text-muted-foreground'>
          {t('accessGroups.generation.hint')}
        </div>
      </div>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 font-medium'>{value}</div>
    </div>
  )
}

/** 模块作用域拿不到 `t`，所以只返回词条 key，由渲染处翻译。 */
const TOKEN_STATUS_KEYS: Record<AccessTokenView['status'], TranslationKey> = {
  ACTIVE: 'accessGroups.tokenPanel.status.active',
  DISABLED: 'accessGroups.tokenPanel.status.disabled',
  REVOKED: 'accessGroups.tokenPanel.status.revoked',
  ARCHIVED: 'accessGroups.tokenPanel.status.archived',
}

function tokenStatusLabelKey(status: AccessTokenView['status']) {
  return TOKEN_STATUS_KEYS[status]
}

function expiryValue(preset: ExpiryPreset, custom: string) {
  if (preset === 'never') return null
  if (preset === 'custom') return custom ? new Date(custom).toISOString() : null
  const date = new Date()
  date.setDate(date.getDate() + Number(preset))
  return date.toISOString()
}

function batchLabelPreview(
  prefix: string,
  quantity: number,
  fallbackPrefix: string
) {
  const safePrefix = prefix.trim() || fallbackPrefix
  const safeQuantity = Math.max(1, Math.min(1000, Math.floor(quantity || 1)))
  const indexes =
    safeQuantity <= 4
      ? Array.from({ length: safeQuantity }, (_, index) => index + 1)
      : [1, 2, 3]
  const preview = indexes.map(
    (index) => `${safePrefix}-${String(index).padStart(3, '0')}`
  )
  if (safeQuantity > 4) {
    preview.push('…', `${safePrefix}-${String(safeQuantity).padStart(3, '0')}`)
  }
  return preview
}

async function copyText(value: string, setCopied?: (copied: boolean) => void) {
  await navigator.clipboard.writeText(value)
  setCopied?.(true)
  toast.success(translateStatic('accessGroups.toast.tokenCopied'))
}

function exportTokensCsv(items: IssuedAccessToken[], group?: AccessGroup) {
  const headers = [
    'label',
    'token',
    'group',
    'initial_points',
    'max_devices',
    'unbind_limit',
    'expires_at',
  ]
  const rows = items.map((item) =>
    [
      item.label,
      item.token,
      group?.displayName ?? String(item.groupId),
      item.initialPoints,
      item.maxMachineBindings,
      item.maxUnbindCount,
      item.expiresAt ?? '',
    ]
      .map(csvCell)
      .join(',')
  )
  const blob = new Blob([`\uFEFF${headers.join(',')}\n${rows.join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `access-tokens-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string | number) {
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className='mb-2'>{label}</Label>
      {children}
    </div>
  )
}

function Toggle({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-4 rounded-md border p-3'>
      <div>
        <div className='text-sm font-medium'>{label}</div>
        <div className='text-xs text-muted-foreground'>{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function fromGroup(group: AccessGroup): SaveAccessGroupBody {
  return {
    id: group.id,
    displayName: group.displayName,
    enabled: group.enabled,
    models: group.modelIds,
    modelMultipliers: { ...group.modelMultipliers },
  }
}

function modelMultiplierRange(group: AccessGroup) {
  const values = Object.values(group.modelMultipliers)
    .map(Number)
    .filter((value) => Number.isFinite(value))
  if (!values.length)
    return translateStatic('accessGroups.group.multiplierUnset')
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  return minimum === maximum
    ? `${formatMultiplier(minimum)}×`
    : `${formatMultiplier(minimum)}×–${formatMultiplier(maximum)}×`
}

function formatMultiplier(value: number) {
  return Number(value).toLocaleString(currentLocaleTag(), {
    maximumFractionDigits: 4,
  })
}

function formatPoints(value: number) {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString(currentLocaleTag(), { maximumFractionDigits: 4 })
}

function formatShortDate(value: string, localeTag: string) {
  return new Intl.DateTimeFormat(localeTag, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : translateStatic('common.error.requestFailed')
}

function showError(error: unknown) {
  toast.error(message(error))
}

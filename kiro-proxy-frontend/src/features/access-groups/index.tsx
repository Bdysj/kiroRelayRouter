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
      toast.success(variables.enabled ? '分组已启用' : '分组已停用')
      void refresh()
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
    },
    onError: showError,
  })
  const remove = useMutation({
    mutationFn: deleteAccessGroup,
    onSuccess: (_, deletedGroupId) => {
      toast.success('分组已删除')
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
      toast.success(`已更新 ${result.updated} 个 Token`)
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
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main className='max-w-none'>
        <div className='mb-6 flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold tracking-tight'>
              访问分组与计费
            </h1>
            <p className='text-muted-foreground'>
              管理用户模型访问权限以及积分计费倍率。
            </p>
          </div>
          <div className='flex gap-2'>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='outline'>
                  <KeyRound />
                  签发 Token
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
                    <span className='block font-medium'>单个签发</span>
                    <span className='block text-xs text-muted-foreground'>
                      创建一个 Access Token
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className='items-start gap-3 p-3'
                  onSelect={() => setIssuingToken('batch')}
                >
                  <Layers3 className='mt-0.5 size-4' />
                  <span>
                    <span className='block font-medium'>批量签发</span>
                    <span className='block text-xs text-muted-foreground'>
                      按照统一配置一次生成多个 Token
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setEditing(null)}>
              <Plus />
              新建分组
            </Button>
          </div>
        </div>

        <div className='mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <AccessSummaryCard
            icon={UsersRound}
            label='分组总数'
            value={summary.data?.groupTotal}
            detail='全部访问分组'
          />
          <AccessSummaryCard
            icon={Key}
            label='Token 总数'
            value={summary.data?.tokenTotal}
            detail='包含所有生命周期状态'
          />
          <AccessSummaryCard
            icon={Box}
            label='启用的分组'
            value={summary.data?.enabledGroupTotal}
            detail={`共 ${summary.data?.groupTotal ?? '—'} 个分组`}
          />
          <AccessSummaryCard
            icon={Power}
            label='启用的 Token'
            value={summary.data?.activeTokenTotal}
            detail={`共 ${summary.data?.tokenTotal ?? '—'} 个 Token`}
          />
        </div>

        <div className='grid items-start gap-4 xl:grid-cols-[430px_minmax(0,1fr)]'>
          <Card className='flex min-h-[680px] min-w-0 flex-col overflow-hidden xl:h-[calc(100vh-17rem)]'>
            <div className='space-y-3 border-b p-4'>
              <h2 className='font-semibold'>
                访问分组（{summary.data?.groupTotal ?? '—'}）
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
                  placeholder='搜索分组名称，按回车筛选'
                />
              </form>
              <div className='flex gap-2'>
                {(
                  [
                    ['all', '全部', summary.data?.groupTotal],
                    ['enabled', '启用', summary.data?.enabledGroupTotal],
                    [
                      'disabled',
                      '停用',
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
                  暂无匹配分组
                </div>
              ) : (
                <Table className='min-w-[430px]'>
                  <TableHeader className='sticky top-0 z-10 bg-background'>
                    <TableRow>
                      <TableHead>分组名称</TableHead>
                      <TableHead>模型权限</TableHead>
                      <TableHead>倍率</TableHead>
                      <TableHead>模型数</TableHead>
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
                              {group.enabled ? '● 启用' : '● 停用'}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant='secondary'>指定模型</Badge>
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
                                  aria-label={`${group.displayName} 操作`}
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align='end'>
                                <DropdownMenuItem
                                  onSelect={() => setPermissionGroup(group)}
                                >
                                  <ShieldCheck />
                                  模型权限与倍率
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => setRenaming(group)}
                                >
                                  <PenLine />
                                  重命名分组
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => setEditing(group)}
                                >
                                  <Pencil />
                                  编辑分组
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
                                  {group.enabled ? '停用分组' : '启用分组'}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className='text-destructive focus:text-destructive'
                                  onSelect={() => {
                                    if (
                                      window.confirm(
                                        `确定删除分组“${group.displayName}”吗？`
                                      )
                                    )
                                      remove.mutate(group.id)
                                  }}
                                >
                                  <Trash2 />
                                  删除分组
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
                unit='个分组'
                onPageChange={setGroupPage}
                compact
              />
            )}
          </Card>

          <Card className='flex min-h-[680px] min-w-0 flex-col overflow-hidden xl:h-[calc(100vh-17rem)]'>
            <div className='space-y-4 border-b p-4'>
              <div>
                <h2 className='font-semibold'>Token 与设备绑定</h2>
                {selectedGroup ? (
                  <div className='mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/45 px-3 py-2.5 text-sm'>
                    <strong>{selectedGroup.displayName}</strong>
                    <Badge
                      variant={selectedGroup.enabled ? 'default' : 'secondary'}
                    >
                      {selectedGroup.enabled ? '启用' : '停用'}
                    </Badge>
                    <span className='text-muted-foreground'>
                      模型数量 {selectedGroup.modelCount}
                    </span>
                    <span className='text-muted-foreground'>
                      模型倍率 {modelMultiplierRange(selectedGroup)}
                    </span>
                    <span className='text-muted-foreground'>
                      Token 绑定后不可切换分组
                    </span>
                  </div>
                ) : (
                  <p className='mt-1 text-sm text-muted-foreground'>
                    请先从左侧选择一个访问分组。
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
                    placeholder='搜索 Label / Token，按回车筛选'
                  />
                </form>
                <FilterSelect
                  ariaLabel='Token 状态'
                  value={tokenStatus}
                  onChange={(value) => {
                    setTokenStatus(value)
                    setTokenPage(1)
                    setSelectedTokens(new Set())
                  }}
                  options={[
                    ['all', '全部状态'],
                    ['ACTIVE', '正常使用'],
                    ['DISABLED', '已停用'],
                    ['REVOKED', '永久撤销'],
                    ['ARCHIVED', '已归档'],
                  ]}
                />
                <FilterSelect
                  ariaLabel='设备状态'
                  value={deviceStatus}
                  onChange={(value) => {
                    setDeviceStatus(value)
                    setTokenPage(1)
                    setSelectedTokens(new Set())
                  }}
                  options={[
                    ['all', '全部设备'],
                    ['unbound', '未绑定'],
                    ['bound', '已绑定'],
                    ['limit', '达到上限'],
                  ]}
                />
              </div>
              <div className='flex flex-wrap items-end justify-between gap-3 rounded-lg bg-muted/45 px-3 py-2.5'>
                <div className='text-sm font-medium'>
                  已选择 {selectedTokens.size} 个 Token
                </div>
                <div className='flex flex-wrap items-end gap-2'>
                  <CompactNumber
                    label='绑定上限'
                    value={bulkBindings}
                    onChange={setBulkBindings}
                  />
                  <CompactNumber
                    label='解绑上限'
                    value={bulkUnbinds}
                    onChange={setBulkUnbinds}
                  />
                  <Button
                    size='sm'
                    disabled={!selectedTokens.size || bulkLimits.isPending}
                    onClick={() => bulkLimits.mutate()}
                  >
                    应用到 {selectedTokens.size} 个 Token
                  </Button>
                </div>
              </div>
            </div>
            {activeGroupId === 'all' ? (
              <div className='flex flex-1 items-center justify-center text-sm text-muted-foreground'>
                请选择访问分组
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
                          aria-label='全选当前页 Token'
                          title='全选当前页 Token'
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
                      <TableHead>状态</TableHead>
                      <TableHead>已绑定设备</TableHead>
                      <TableHead>绑定上限</TableHead>
                      <TableHead>剩余可解绑</TableHead>
                      <TableHead>解绑上限</TableHead>
                      <TableHead>最近使用</TableHead>
                      <TableHead className='text-right'>操作</TableHead>
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
                          暂无访问 Token
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
                unit='个 Token'
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
      toast.success(`Token“${token.label}”限制已更新`)
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
        status === 'ACTIVE'
          ? 'Token 已启用'
          : status === 'DISABLED'
            ? 'Token 已停用'
            : 'Token 已永久撤销'
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
      toast.success('Token 已归档，账单和用量历史已保留')
      void client.invalidateQueries({ queryKey: ['admin-access-tokens'] })
      void client.invalidateQueries({ queryKey: ['admin-access-summary'] })
    },
    onError: showError,
  })
  const hardDelete = useMutation({
    mutationFn: () => hardDeleteAccessToken(token.id),
    onSuccess: () => {
      setPendingAction(null)
      toast.success('未使用 Token 已物理删除')
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
              title='点击查看完整 Token'
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
            {tokenStatusLabel(token.status)}
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
          {token.lastUsedAt ? formatShortDate(token.lastUsedAt) : '从未使用'}
        </TableCell>
        <TableCell className='text-right'>
          <div className='flex justify-end gap-1'>
            <Button
              size='sm'
              variant='ghost'
              disabled={save.isPending || immutable}
              onClick={() => save.mutate()}
            >
              <Save /> 保存
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size='icon' variant='ghost' aria-label='Token 操作'>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                {token.status === 'ACTIVE' && (
                  <DropdownMenuItem
                    onSelect={() => setPendingAction('DISABLE')}
                  >
                    <Ban /> 停用 Token
                  </DropdownMenuItem>
                )}
                {token.status === 'DISABLED' && (
                  <DropdownMenuItem onSelect={() => setPendingAction('ENABLE')}>
                    <KeyRound /> 启用 Token
                  </DropdownMenuItem>
                )}
                {(token.status === 'ACTIVE' || token.status === 'DISABLED') && (
                  <DropdownMenuItem
                    className='text-destructive focus:text-destructive'
                    onSelect={() => setPendingAction('REVOKE')}
                  >
                    <Ban /> 安全撤销（永久）
                  </DropdownMenuItem>
                )}
                {token.status !== 'ARCHIVED' && (
                  <DropdownMenuItem
                    onSelect={() => setPendingAction('ARCHIVE')}
                  >
                    <Archive /> 归档并隐藏
                  </DropdownMenuItem>
                )}
                {token.canHardDelete && (
                  <DropdownMenuItem
                    className='text-destructive focus:text-destructive'
                    onSelect={() => setPendingAction('DELETE')}
                  >
                    <Trash2 /> 物理删除
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
            <DialogTitle>完整访问 Token</DialogTitle>
            <DialogDescription>{token.label}</DialogDescription>
          </DialogHeader>
          <div className='flex items-start gap-3 rounded-md bg-muted/55 p-3 text-sm'>
            <LockKeyhole className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
            <div>
              <div className='font-medium'>{token.groupDisplayName}</div>
              <div className='text-xs text-muted-foreground'>
                {token.groupModelCount}个模型 · 按模型倍率计费 · 签发后不可修改
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
              重新签发 Token
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
                  toast.success('Token 已复制')
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? '已复制' : '复制 Token'}
              </Button>
            </div>
          ) : (
            <div className='py-8 text-center text-sm text-muted-foreground'>
              该 Token 无法恢复，请重新签发。
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
        title={
          pendingAction === 'ENABLE'
            ? `启用 Token“${token.label}”`
            : pendingAction === 'DISABLE'
              ? `停用 Token“${token.label}”`
              : pendingAction === 'REVOKE'
                ? `安全撤销 Token“${token.label}”`
                : pendingAction === 'ARCHIVE'
                  ? `归档并隐藏 Token“${token.label}”`
                  : `物理删除 Token“${token.label}”`
        }
        desc={
          <div className='space-y-2'>
            {pendingAction === 'ENABLE' && (
              <p>
                启用后该 Token
                可以重新发起请求，原有账单、用量和钱包记录保持不变。
              </p>
            )}
            {pendingAction === 'DISABLE' && (
              <>
                <p>停用后该 Token 将立即停止使用，但以后可以重新启用。</p>
                <p>不会删除 Token，也不会删除用量、账本、钱包或账单历史。</p>
              </>
            )}
            {pendingAction === 'REVOKE' && (
              <>
                <p>
                  撤销后该 Token
                  永久失效，不能再次启用，但仍会保留在默认列表中作为安全审计记录。
                </p>
                <p>
                  不会删除任何用量、账本、钱包或账单历史；如需隐藏，可在撤销后再归档。
                </p>
              </>
            )}
            {pendingAction === 'ARCHIVE' && (
              <>
                <p>
                  归档后该 Token
                  无法使用，并从默认列表隐藏，可通过“已归档”状态筛选查看。
                </p>
                <p>Token 主记录及其用量、账本、钱包和账单历史都会完整保留。</p>
              </>
            )}
            {pendingAction === 'DELETE' && (
              <>
                <p>
                  该 Token
                  经后端判定从未使用，且不存在用量、有效账本、钱包变更或机器绑定记录。
                </p>
                <p className='font-medium text-destructive'>
                  物理删除会移除 Token 主记录且不能恢复。
                </p>
              </>
            )}
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          pendingAction === 'ENABLE'
            ? '确认启用'
            : pendingAction === 'DISABLE'
              ? '确认停用'
              : pendingAction === 'REVOKE'
                ? '确认安全撤销'
                : pendingAction === 'ARCHIVE'
                  ? '确认归档并隐藏'
                  : '确认物理删除'
        }
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
  unit,
  onPageChange,
  compact = false,
}: {
  page: number
  totalPages: number
  total: number
  unit: string
  onPageChange: (page: number) => void
  compact?: boolean
}) {
  return (
    <div className='flex min-w-max items-center justify-between gap-4 border-t px-4 py-3 text-sm'>
      <span className='text-muted-foreground'>
        共 {total} {unit}
      </span>
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label='上一页'
        >
          <ChevronLeft />
          {!compact && '上一页'}
        </Button>
        <span className='min-w-16 text-center tabular-nums'>
          {page} / {totalPages}
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label='下一页'
        >
          {!compact && '下一页'}
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
  return (
    <Card>
      <CardContent className='flex items-center gap-4 p-4'>
        <span className='flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-black ring-1 ring-black/10 transition-colors dark:bg-black dark:text-white dark:ring-white/15'>
          <Icon className='size-5' />
        </span>
        <div className='min-w-0'>
          <div className='text-sm text-muted-foreground'>{label}</div>
          <div className='text-2xl font-bold tabular-nums'>
            {value == null ? '—' : value.toLocaleString('zh-CN')}
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
  const [displayName, setDisplayName] = useState(group.displayName)
  const rename = useMutation({
    mutationFn: (name: string) => renameAccessGroup(group.id, name),
    onSuccess: () => {
      toast.success('分组名称已更新')
      onSaved()
    },
    onError: showError,
  })
  const submit = () => {
    const name = displayName.trim()
    if (!name) return toast.error('请输入分组名称')
    if (name.length > 128) return toast.error('分组名称不能超过 128 个字符')
    if (name === group.displayName) return onClose()
    rename.mutate(name)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>重命名访问分组</DialogTitle>
          <DialogDescription>
            分组名称只用于展示，Token 鉴权与历史计费流水都按分组 ID
            关联，改名不影响 既有配置。
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 py-2'>
          <Field label='分组名称'>
            <Input
              autoFocus
              value={displayName}
              maxLength={128}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && submit()}
              placeholder='例如：VIP 用户'
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={rename.isPending}>
            {rename.isPending && <Loader2 className='animate-spin' />}
            保存名称
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
      toast.success(group ? '分组已更新' : '分组已创建')
      onSaved()
    },
    onError: showError,
  })
  const submit = () => {
    const displayName = form.displayName.trim()
    if (!displayName) return toast.error('请输入分组名称')
    if (displayName.length > 128)
      return toast.error('分组名称不能超过 128 个字符')
    save.mutate({ ...form, displayName })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? '编辑访问分组' : '新建访问分组'}</DialogTitle>
          <DialogDescription>
            设置分组身份和基本状态；模型权限与模型倍率在独立面板中配置。
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 py-2'>
          <Field label='分组名称'>
            <Input
              value={form.displayName}
              maxLength={128}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
              placeholder='例如：VIP 用户'
            />
          </Field>
          <Toggle
            label='启用分组'
            description='停用后，该分组的 Token 将无法认证'
            checked={form.enabled}
            onCheckedChange={(checked) =>
              setForm({ ...form, enabled: checked })
            }
          />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className='animate-spin' />}
            保存
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
      toast.success('模型权限已更新')
      onSaved()
    },
    onError: showError,
  })
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className='sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>{group.displayName} · 模型权限与倍率</SheetTitle>
          <SheetDescription>
            配置该分组可用的平台模型，并为每个模型设置独立的模型倍率。
          </SheetDescription>
        </SheetHeader>
        <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4'>
          <div className='relative'>
            <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
            <Input
              className='pl-9'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='搜索 Model ID / 模型名称'
            />
          </div>
          <div className='flex items-center justify-between text-sm text-muted-foreground'>
            <span>已选 {selected.size} 个模型</span>
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
                全选
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setSelected(new Set())}
              >
                清空
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
                    aria-label={`${model.displayName} 模型倍率`}
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
                    placeholder='倍率'
                  />
                ) : !model.enabled ? (
                  <Badge variant='secondary'>已停用</Badge>
                ) : (
                  <span />
                )}
              </label>
            ))}
          </div>
        </div>
        <SheetFooter>
          <Button variant='outline' onClick={onClose}>
            取消
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
                return toast.error('请为每个已选模型配置大于 0 的模型倍率')
              save.mutate({
                ...fromGroup(group),
                models: [...selected],
                modelMultipliers: normalized,
              })
            }}
          >
            {save.isPending && <Loader2 className='animate-spin' />}
            保存模型权限与倍率
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
      toast.success('Token 签发成功')
    },
    onError: showError,
  })
  const submit = () => {
    const points = Number(initialPoints)
    const expiresAt = expiryValue(expiry, customExpiry)
    if (!label.trim()) return toast.error('请输入 Token 名称')
    if (!groupId) return toast.error('请选择访问分组')
    if (!Number.isFinite(points) || points < 0)
      return toast.error('初始积分不能小于 0')
    if (expiry === 'custom' && !expiresAt)
      return toast.error('请选择自定义过期时间')
    if (expiresAt && new Date(expiresAt) <= new Date())
      return toast.error('过期时间必须晚于当前时间')
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
          <SheetTitle>{issued ? 'Token 签发成功' : '签发 Token'}</SheetTitle>
          <SheetDescription>
            {issued
              ? '新的访问 Token 已生成。'
              : '创建一个新的访问 Token，并设置初始积分与设备使用限制。'}
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
                label='初始积分'
                value={formatPoints(issued.initialPoints)}
              />
              <Summary
                label='设备上限'
                value={
                  issued.maxMachineBindings === 0
                    ? '不限'
                    : `${issued.maxMachineBindings} 台`
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
                  aria-label='复制 Token'
                  onClick={() => void copyText(issued.token, setCopied)}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
              <p className='text-sm font-medium'>
                请立即复制并妥善保存 Token。
              </p>
            </section>
          </div>
        ) : (
          <div className='flex-1 overflow-y-auto px-4 pb-4'>
            <FormSection title='基础信息'>
              <Field label='Token 名称 / Label'>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder='例如：客户A-生产环境'
                />
              </Field>
              <Field label='所属访问分组'>
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
                    label='模型倍率'
                    value={modelMultiplierRange(selectedGroup)}
                  />
                  <Summary
                    label='模型权限'
                    value={`${selectedGroup.modelCount} 个模型`}
                  />
                </div>
              )}
            </FormSection>
            <FormSection title='使用限制'>
              <Toggle
                label='启用 Token'
                description='签发后可立即用于访问'
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <div className='grid grid-cols-2 gap-3'>
                <Field label='设备绑定上限'>
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
                    0 = 不限制设备数量
                  </p>
                </Field>
                <Field label='允许解绑次数'>
                  <Input
                    type='number'
                    min={0}
                    value={maxUnbindCount}
                    onChange={(event) =>
                      setMaxUnbindCount(Math.max(0, Number(event.target.value)))
                    }
                  />
                  <p className='mt-1.5 text-xs text-muted-foreground'>
                    0 = 禁止用户主动解绑
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
            <FormSection title='初始积分'>
              <Field label='初始积分'>
                <Input
                  type='text'
                  inputMode='decimal'
                  value={initialPoints}
                  onChange={(event) => setInitialPoints(event.target.value)}
                />
              </Field>
              <div className='space-y-1 rounded-md bg-muted/60 p-3 text-sm'>
                <div>
                  当前模型倍率：
                  <strong>
                    {selectedGroup ? modelMultiplierRange(selectedGroup) : '—'}
                  </strong>
                </div>
                <div>
                  基础规则：1 USD 模型成本 ={' '}
                  {pointsPerUsd == null
                    ? '读取中…'
                    : `${formatPoints(pointsPerUsd)} 积分`}
                </div>
                <div>
                  该 Token 初始余额：
                  <strong>{formatPoints(Number(initialPoints))} 积分</strong>
                </div>
              </div>
            </FormSection>
            <FormSection title='生成方式' last>
              <GenerationInfo label='自动安全生成' />
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
                <Copy /> 复制 Token
              </Button>
              <Button onClick={onClose}>完成</Button>
            </>
          ) : (
            <>
              <Button variant='outline' onClick={onClose}>
                取消
              </Button>
              <Button
                disabled={mutation.isPending || !availableGroups.length}
                onClick={submit}
              >
                {mutation.isPending && <Loader2 className='animate-spin' />}
                签发 Token
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
      toast.success(`已成功生成 ${result.quantity} 个 Token`)
    },
    onError: showError,
  })
  const submit = () => {
    const expiresAt = expiryValue(expiry, customExpiry)
    if (!labelPrefix.trim()) return toast.error('请输入 Token 名称前缀')
    if (!groupId) return toast.error('请选择访问分组')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000)
      return toast.error('生成数量必须是 1 到 1000 的整数')
    if (!Number.isFinite(points) || points < 0)
      return toast.error('每个 Token 初始积分不能小于 0')
    if (expiry === 'custom' && !expiresAt)
      return toast.error('请选择自定义过期时间')
    if (expiresAt && new Date(expiresAt) <= new Date())
      return toast.error('过期时间必须晚于当前时间')
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
          <SheetTitle>{issued ? '批量签发完成' : '批量签发 Token'}</SheetTitle>
          <SheetDescription>
            {issued
              ? `已成功生成 ${issued.quantity} 个 Token。`
              : '使用相同配置一次创建多个访问 Token，适合批量销售、活动发放和测试环境。'}
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
            <FormSection title='批量规则'>
              <Field label='所属访问分组'>
                <GroupSelect
                  groups={availableGroups}
                  value={groupId}
                  onChange={setGroupId}
                />
              </Field>
              <ImmutableGroupNotice batch />
              <div className='grid grid-cols-[140px_1fr] gap-3'>
                <Field label='生成数量'>
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
                <Field label='Token 名称前缀'>
                  <Input
                    value={labelPrefix}
                    onChange={(event) => setLabelPrefix(event.target.value)}
                    placeholder='例如：淘宝套餐20元'
                    maxLength={120}
                  />
                </Field>
              </div>
              <div className='rounded-md bg-muted/55 p-3 text-xs text-muted-foreground'>
                <span className='mb-1 block font-medium text-foreground'>
                  实时预览
                </span>
                {batchLabelPreview(labelPrefix, quantity).map((label) => (
                  <span key={label} className='block font-mono'>
                    {label}
                  </span>
                ))}
              </div>
            </FormSection>
            <FormSection title='统一使用限制'>
              <Toggle
                label='启用 Token'
                description='本批次签发后可立即使用'
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <div className='grid grid-cols-2 gap-3'>
                <Field label='设备绑定上限'>
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
                <Field label='允许解绑次数'>
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
                以上配置将应用到本批次全部 Token。
              </p>
            </FormSection>
            <FormSection title='统一初始积分'>
              <Field label='每个 Token 初始积分'>
                <Input
                  type='text'
                  inputMode='decimal'
                  value={initialPoints}
                  onChange={(event) => setInitialPoints(event.target.value)}
                />
              </Field>
              <div className='grid grid-cols-2 gap-3 rounded-md bg-muted/55 p-3 text-sm sm:grid-cols-4'>
                <Summary label='生成数量' value={String(quantity)} />
                <Summary label='每个积分' value={formatPoints(points)} />
                <Summary
                  label='总发放积分'
                  value={`${formatPoints(totalPoints)} Points`}
                />
                <Summary
                  label='访问分组 / 模型倍率'
                  value={`${selectedGroup?.displayName ?? '—'} · ${selectedGroup ? modelMultiplierRange(selectedGroup) : '—'}`}
                />
              </div>
            </FormSection>
            <FormSection title='生成方式' last>
              <GenerationInfo label='服务端安全随机生成' />
            </FormSection>
          </div>
        )}
        {!issued && (
          <SheetFooter className='border-t'>
            <div className='me-auto hidden text-xs text-muted-foreground sm:block'>
              即将生成 <strong className='text-foreground'>{quantity}</strong>{' '}
              个 Token · {selectedGroup?.displayName ?? '未选择分组'} ·{' '}
              {formatPoints(points)} 积分 / Token · 总计{' '}
              {formatPoints(totalPoints)} Points · 设备上限{' '}
              {maxMachineBindings === 0 ? '不限' : `${maxMachineBindings}台`}
            </div>
            <Button variant='outline' onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={mutation.isPending || !availableGroups.length}
              onClick={submit}
            >
              {mutation.isPending && <Loader2 className='animate-spin' />}
              批量签发 {quantity} 个 Token
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
          <Check className='size-5' /> 已成功生成 {result.quantity} 个 Token
        </div>
        <div className='flex gap-2'>
          <Button variant='outline' size='sm' onClick={() => void copyAll()}>
            <Copy /> 复制全部
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => exportTokensCsv(result.items, group)}
          >
            <Download /> 导出 CSV
          </Button>
        </div>
      </div>
      <div className='min-h-0 flex-1 overflow-auto rounded-md border'>
        <Table className='min-w-[760px]'>
          <TableHeader className='sticky top-0 bg-background'>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>分组</TableHead>
              <TableHead>初始积分</TableHead>
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
                      aria-label={`复制 ${item.label}`}
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
        <Button onClick={onDone}>完成</Button>
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
  return (
    <div className='flex gap-3 rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/30'>
      <LockKeyhole className='mt-0.5 size-4 shrink-0 text-blue-600' />
      <div>
        <div className='font-medium'>分组绑定后不可修改</div>
        <p className='mt-0.5 text-xs text-muted-foreground'>
          {batch
            ? '本批次生成的所有 Token 都将永久绑定到该访问分组。'
            : 'Token 签发后将永久绑定当前访问分组。如需使用其他分组，请重新签发新的 Token。'}
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
  return (
    <select
      className='h-10 w-full rounded-md border bg-background px-3 text-sm'
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {!groups.length && <option value={0}>暂无已启用分组</option>}
      {groups.map((group) => (
        <option key={group.id} value={group.id}>
          {group.displayName} · {modelMultiplierRange(group)} ·{' '}
          {group.modelCount}个模型
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
  return (
    <>
      <Field label='过期时间'>
        <select
          className='h-10 w-full rounded-md border bg-background px-3 text-sm'
          value={expiry}
          onChange={(event) =>
            onExpiryChange(event.target.value as ExpiryPreset)
          }
        >
          <option value='never'>永不过期</option>
          <option value='7'>7 天</option>
          <option value='30'>30 天</option>
          <option value='90'>90 天</option>
          <option value='365'>1 年</option>
          <option value='custom'>自定义时间</option>
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
  return (
    <div className='flex items-center gap-3 text-sm'>
      <span className='size-2.5 rounded-full bg-primary' />
      <div>
        <div className='font-medium'>{label}</div>
        <div className='text-xs text-muted-foreground'>
          sk_ + 安全随机字符 · Token 将由服务端生成
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

function tokenStatusLabel(status: AccessTokenView['status']) {
  return {
    ACTIVE: '正常',
    DISABLED: '停用',
    REVOKED: '已撤销',
    ARCHIVED: '已归档',
  }[status]
}

function expiryValue(preset: ExpiryPreset, custom: string) {
  if (preset === 'never') return null
  if (preset === 'custom') return custom ? new Date(custom).toISOString() : null
  const date = new Date()
  date.setDate(date.getDate() + Number(preset))
  return date.toISOString()
}

function batchLabelPreview(prefix: string, quantity: number) {
  const safePrefix = prefix.trim() || 'Token名称前缀'
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
  toast.success('Token 已复制')
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
  if (!values.length) return '未配置'
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  return minimum === maximum
    ? `${formatMultiplier(minimum)}×`
    : `${formatMultiplier(minimum)}×–${formatMultiplier(maximum)}×`
}

function formatMultiplier(value: number) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

function formatPoints(value: number) {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function message(error: unknown) {
  return error instanceof Error ? error.message : '请求失败'
}

function showError(error: unknown) {
  toast.error(message(error))
}

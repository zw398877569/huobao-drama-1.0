import { skillsAPI } from '~/composables/useApi'

type AgentDef = { type: string, label: string, icon: string }

export function useSettingsSkills(agentDefs: AgentDef[]) {
  // Which agent's skills we're currently browsing
  const selectedAgent = ref('script_rewriter')

  // Skill list + editor state
  const allSkills = ref<any[]>([])   // { id, name, description }[]
  const editingSkill = ref<string | null>(null)
  const skillContent = ref('')
  const skillSaving = ref(false)
  const skillSaved = ref<string | null>(null)

  // New-skill dialog
  const addSkillDialog = ref(false)
  const newSkillForm = reactive({ id: '', name: '', description: '' })

  // Derived: label/icon for the currently selected agent
  const selectedAgentType = computed(() => selectedAgent.value)
  const selectedAgentLabel = computed(() => agentDefs.find(a => a.type === selectedAgent.value)?.label || '')
  const selectedAgentIcon = computed(() => agentDefs.find(a => a.type === selectedAgent.value)?.icon || '')

  function agentSkillCount(type: string) {
    return allSkills.value.filter(s => s.id === type || s.id.startsWith(type + '/')).length
  }

  const currentSkills = computed(() =>
    allSkills.value.filter(s => s.id === selectedAgent.value || s.id.startsWith(selectedAgent.value + '/'))
  )

  async function loadAllSkills() {
    try { allSkills.value = await skillsAPI.list() }
    catch (e: any) { toast.error(e.message) }
  }

  async function selectAgent(type: string) {
    selectedAgent.value = type
    editingSkill.value = null
  }

  function startAddSkill() {
    newSkillForm.id = ''
    newSkillForm.name = ''
    newSkillForm.description = ''
    addSkillDialog.value = true
  }

  async function confirmAddSkill() {
    if (!newSkillForm.id) return
    const skillId = `${selectedAgent.value}/${newSkillForm.id}`
    try {
      await skillsAPI.create({ id: skillId, name: newSkillForm.name, description: newSkillForm.description })
      addSkillDialog.value = false
      await loadAllSkills()
      toast.success('Skill 创建成功')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function deleteSkill(id: string) {
    if (!confirm(`确定删除 Skill「${id}」？`)) return
    try {
      await skillsAPI.delete(id)
      if (editingSkill.value === id) editingSkill.value = null
      await loadAllSkills()
      toast.success('已删除')
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function toggleSkillEdit(id: string) {
    if (editingSkill.value === id) { editingSkill.value = null; return }
    try {
      const res = await skillsAPI.get(id)
      skillContent.value = res.content
      skillSaved.value = null
      editingSkill.value = id
    } catch (e: any) { toast.error(e.message) }
  }

  async function saveSkill(id: string) {
    skillSaving.value = true
    skillSaved.value = null
    try {
      await skillsAPI.update(id, skillContent.value)
      await loadAllSkills()
      skillSaved.value = id
      toast.success(`已保存`)
      setTimeout(() => { if (skillSaved.value === id) skillSaved.value = null }, 3000)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      skillSaving.value = false
    }
  }

  onMounted(loadAllSkills)

  return {
    // state
    selectedAgent, allSkills, editingSkill, skillContent, skillSaving, skillSaved,
    addSkillDialog, newSkillForm,
    // computed
    selectedAgentType, selectedAgentLabel, selectedAgentIcon,
    agentSkillCount, currentSkills,
    // actions
    loadAllSkills, selectAgent, startAddSkill, confirmAddSkill,
    deleteSkill, toggleSkillEdit, saveSkill,
  }
}

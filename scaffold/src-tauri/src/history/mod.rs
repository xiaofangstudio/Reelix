//! 撤销栈。剪辑操作与特效操作在同一个栈里：用户按一次 Ctrl+Z，
//! 撤销的是他上一次做的任何事，不区分属于哪一层。
//!
//! 骨架阶段用「整项目 + 关键帧快照」实现，简单可靠；M2 之后再换成差量补丁。
//! 关键帧必须进快照——否则撤销一次「打关键帧」只会把项目退回去，曲线却留在原地。

use serde::Serialize;

use crate::keyframe::model::Curve;
use crate::project::model::Project;

/// 一条历史记录（发给前端的精简视图）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub index: usize,
    /// 中文描述，用于历史面板
    pub description: String,
}

/// 栈里的一个状态快照。项目与关键帧一起存，撤销才能把曲线也退回去。
#[derive(Debug, Clone)]
struct Record {
    description: String,
    project: Project,
    keyframes: Vec<Curve>,
}

/// 撤销栈。
#[derive(Debug, Default)]
pub struct History {
    records: Vec<Record>,
    /// 当前所处的位置（records 的下标）
    cursor: usize,
}

impl History {
    pub fn new() -> Self {
        Self::default()
    }

    /// 清空。
    pub fn clear(&mut self) {
        self.records.clear();
        self.cursor = 0;
    }

    /// 重置为一个新起点（新建 / 打开项目时用）。
    pub fn reset(&mut self, description: &str, project: &Project, keyframes: &[Curve]) {
        self.records.clear();
        self.records.push(Record {
            description: description.to_string(),
            project: project.clone(),
            keyframes: keyframes.to_vec(),
        });
        self.cursor = 0;
    }

    /// 记录一步操作。会丢弃当前位置之后的重做分支。
    pub fn push(&mut self, description: &str, project: &Project, keyframes: &[Curve]) {
        if self.records.is_empty() {
            self.reset(description, project, keyframes);
            return;
        }
        self.records.truncate(self.cursor + 1);
        self.records.push(Record {
            description: description.to_string(),
            project: project.clone(),
            keyframes: keyframes.to_vec(),
        });
        self.cursor = self.records.len() - 1;
    }

    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_redo(&self) -> bool {
        self.cursor + 1 < self.records.len()
    }

    /// 撤销一步，返回 (描述, 项目快照, 关键帧快照)。
    pub fn undo(&mut self) -> Option<(String, Project, Vec<Curve>)> {
        if !self.can_undo() {
            return None;
        }
        self.cursor -= 1;
        let record = &self.records[self.cursor];
        Some((
            record.description.clone(),
            record.project.clone(),
            record.keyframes.clone(),
        ))
    }

    /// 重做一步，返回 (描述, 项目快照, 关键帧快照)。
    pub fn redo(&mut self) -> Option<(String, Project, Vec<Curve>)> {
        if !self.can_redo() {
            return None;
        }
        self.cursor += 1;
        let record = &self.records[self.cursor];
        Some((
            record.description.clone(),
            record.project.clone(),
            record.keyframes.clone(),
        ))
    }

    /// 历史列表。
    pub fn list(&self) -> Vec<HistoryEntry> {
        self.records
            .iter()
            .enumerate()
            .map(|(index, r)| HistoryEntry {
                index,
                description: r.description.clone(),
            })
            .collect()
    }

    /// 跳到某个历史点，返回该点的 (项目, 关键帧) 快照。
    pub fn jump(&mut self, index: usize) -> Option<(Project, Vec<Curve>)> {
        if index >= self.records.len() {
            return None;
        }
        self.cursor = index;
        let record = &self.records[index];
        Some((record.project.clone(), record.keyframes.clone()))
    }

    /// 当前位置。
    pub fn position(&self) -> usize {
        self.cursor
    }
}

/// 把「当前项目 + 当前关键帧」记入撤销栈。
///
/// 调用方若已经持有 `project` 锁，请把项目引用传进来，避免重复加锁造成自锁；
/// 不持有锁时改用 [`commit`]。
pub fn record(
    state: &crate::state::AppState,
    description: &str,
    project: &Project,
) -> Result<(), String> {
    let keyframes = crate::state::lock(&state.keyframes)?.curves();
    crate::state::lock(&state.history)?.push(description, project, &keyframes);
    Ok(())
}

/// 把当前状态记入撤销栈（自行取项目快照）。
///
/// 调用方不得持有 `project` 锁——本函数会去锁它。
pub fn commit(state: &crate::state::AppState, description: &str) -> Result<(), String> {
    let project = {
        let guard = crate::state::lock(&state.project)?;
        match guard.as_ref() {
            Some(project) => project.clone(),
            // 没有项目就不记，避免把空状态压进栈。
            None => return Ok(()),
        }
    };
    record(state, description, &project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyframe::model::{EasingPreset, Keyframe, Tangent};
    use crate::project::serialize::new_project;

    fn one_curve() -> Vec<Curve> {
        vec![Curve {
            target_id: "n1".into(),
            param: "opacity".into(),
            keyframes: vec![Keyframe {
                id: "k1".into(),
                target_id: "n1".into(),
                param: "opacity".into(),
                time_ms: 0.0,
                value: 1.0,
                easing: EasingPreset::Linear,
                in_tangent: Tangent::new(0.0, 0.0),
                out_tangent: Tangent::new(0.0, 0.0),
            }],
        }]
    }

    /// 全新的撤销栈既不能撤销也不能重做。
    #[test]
    fn new_history_can_neither_undo_nor_redo() {
        let h = History::new();
        assert!(!h.can_undo(), "空栈不该能撤销");
        assert!(!h.can_redo(), "空栈不该能重做");
        assert_eq!(h.position(), 0);
    }

    /// reset 立一个起点：能撤销才算有历史，但起点本身不能撤销。
    #[test]
    fn reset_establishes_a_baseline() {
        let mut h = History::new();
        h.reset("新建项目", &new_project("s0"), &[]);
        assert!(!h.can_undo(), "只有一个起点时不该能撤销");
        assert!(!h.can_redo());
        assert_eq!(h.list().len(), 1);
        assert_eq!(h.list()[0].description, "新建项目");
    }

    /// 空栈上直接 push 等价于 reset，不会制造出可撤销的一步。
    #[test]
    fn push_on_empty_stack_behaves_like_reset() {
        let mut h = History::new();
        h.push("打开项目", &new_project("s0"), &[]);
        assert!(!h.can_undo(), "首条记录只作起点，不该能撤销");
        assert_eq!(h.list().len(), 1);
    }

    /// 撤销返回的是「上一步操作之前」的快照。
    #[test]
    fn undo_returns_previous_snapshot() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        h.push("移动片段", &new_project("s1"), &[]);

        assert!(h.can_undo());
        let (desc, project, _) = h.undo().expect("应当能撤销");
        assert_eq!(desc, "新建");
        assert_eq!(project.name, "s0", "撤销后应当回到 s0");
        assert_eq!(h.position(), 0);
    }

    /// 撤到底还能再重做回来。
    #[test]
    fn redo_walks_forward_again() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        h.push("移动片段", &new_project("s1"), &[]);

        h.undo();
        assert!(h.can_redo());
        let (desc, project, _) = h.redo().expect("应当能重做");
        assert_eq!(desc, "移动片段");
        assert_eq!(project.name, "s1");
        assert!(!h.can_redo(), "重做到头后不该还能重做");
    }

    /// 撤销到底后返回 None，而不是 panic。
    #[test]
    fn undo_and_redo_at_boundaries_return_none() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        assert!(h.undo().is_none(), "起点处撤销应当返回 None");

        h.push("移动", &new_project("s1"), &[]);
        assert!(h.redo().is_none(), "最新处重做应当返回 None");
    }

    /// 撤销后做了新操作，原来的重做分支必须被丢掉。
    #[test]
    fn push_after_undo_drops_the_redo_branch() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        h.push("一步", &new_project("s1"), &[]);
        h.push("二步", &new_project("s2"), &[]);
        h.push("三步", &new_project("s3"), &[]);
        assert_eq!(h.list().len(), 4);

        h.undo();
        h.push("改道", &new_project("sX"), &[]);

        assert_eq!(h.list().len(), 4, "改道后旧的「三步」应当被截掉");
        assert!(!h.can_redo(), "改道后不该还能重做");
        assert_eq!(h.list().last().unwrap().description, "改道");
    }

    /// jump 越界返回 None，合法时移动游标并给出快照。
    #[test]
    fn jump_moves_cursor_and_returns_snapshot() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        h.push("一步", &new_project("s1"), &[]);
        h.push("二步", &new_project("s2"), &[]);

        assert!(h.jump(99).is_none(), "越界跳转应当返回 None");
        let (project, _) = h.jump(1).expect("合法跳转应当成功");
        assert_eq!(h.position(), 1);
        assert_eq!(project.name, "s1");
        assert!(h.can_undo());
        assert!(h.can_redo());
    }

    /// 历史列表要带下标与中文描述，供历史面板按序展示。
    #[test]
    fn list_exposes_index_and_chinese_description() {
        let mut h = History::new();
        h.reset("新建项目", &new_project("s0"), &[]);
        h.push("添加特效", &new_project("s1"), &[]);

        let entries = h.list();
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[1].index, 1);
        assert_eq!(entries[1].description, "添加特效");
    }

    /// clear 之后栈彻底清空，游标归零。
    #[test]
    fn clear_empties_the_stack() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        h.push("一步", &new_project("s1"), &[]);
        h.clear();

        assert_eq!(h.position(), 0);
        assert!(h.list().is_empty());
        assert!(!h.can_undo());
        assert!(!h.can_redo());
    }

    /// 关键帧必须随快照一起走：撤销回到打帧之前，重做又把它带回来。
    #[test]
    fn keyframes_travel_with_the_snapshot() {
        let mut h = History::new();
        h.reset("新建", &new_project("s0"), &[]);
        h.push("打关键帧", &new_project("s1"), &one_curve());

        let (_, _, undone) = h.undo().expect("应当能撤销");
        assert!(undone.is_empty(), "撤销后关键帧应当回到起点（空）");

        let (_, _, redone) = h.redo().expect("应当能重做");
        assert_eq!(redone.len(), 1, "重做后关键帧应当回来");
        assert_eq!(redone[0].param, "opacity");

        let (_, jumped) = h.jump(1).expect("跳转应当成功");
        assert_eq!(jumped.len(), 1, "跳到该点也应带回关键帧");
    }
}

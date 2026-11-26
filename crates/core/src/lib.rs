use serde::{Deserialize, Serialize};
// Fixed 240000 Hz timeline; common integer and NTSC frame rates are exact.
// Other time bases will require explicit rounding or rational conversion.
pub type Tick = u64;
pub const TICKS_PER_SECOND: Tick = 240_000;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clip { pub id: u64, pub asset: String, pub start: Tick, pub source_in: Tick, pub duration: Tick }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Track { pub clips: Vec<Clip> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project { pub schema: u32, pub tracks: Vec<Track> }
impl Default for Project { fn default() -> Self { Self { schema: 1, tracks: vec![Track::default()] } } }
#[derive(Debug, PartialEq, Eq)]
pub enum EditError { MissingClip, DuplicateId, OutsideClip, Overflow }
impl Track {
    pub fn split(&mut self, id: u64, at: Tick, new_id: u64) -> Result<(), EditError> {
        if self.clips.iter().any(|c| c.id == new_id) { return Err(EditError::DuplicateId); }
        let i = self.clips.iter().position(|c| c.id == id).ok_or(EditError::MissingClip)?;
        let c = &self.clips[i];
        let end = c.start.checked_add(c.duration).ok_or(EditError::Overflow)?;
        if at <= c.start || at >= end { return Err(EditError::OutsideClip); }
        let delta = at - c.start;
        let right = Clip { id: new_id, asset: c.asset.clone(), start: at,
            source_in: c.source_in.checked_add(delta).ok_or(EditError::Overflow)?,
            duration: c.duration - delta };
        self.clips[i].duration = delta;
        self.clips.insert(i+1, right);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn track() -> Track { Track { clips: vec![Clip { id:1, asset:"asset1".into(), start:100, source_in:20, duration:100 }] } }
    #[test] fn split_preserves_source() {
        let mut t=track(); t.split(1,140,2).unwrap();
        assert_eq!(t.clips[0].duration,40);
        assert_eq!(t.clips[1].source_in,60);
        assert_eq!(t.clips[1].duration,60);
        assert_eq!(t.clips[1].start,140);
    }
    #[test] fn rejects_boundary_without_mutation() {
        let mut t=track(); let before=t.clone();
        assert_eq!(t.split(1,200,2),Err(EditError::OutsideClip)); assert_eq!(t,before);
    }
    #[test] fn rejects_duplicate() {
        let mut t=track(); assert_eq!(t.split(1,140,1),Err(EditError::DuplicateId));
    }
    #[test] fn project_roundtrip() {
        let mut p=Project::default(); p.tracks[0]=track();
        assert_eq!(serde_json::from_str::<Project>(&serde_json::to_string(&p).unwrap()).unwrap(),p);
    }
}

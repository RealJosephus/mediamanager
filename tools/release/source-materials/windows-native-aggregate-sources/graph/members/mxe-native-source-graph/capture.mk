$(file >$(MM_RECORDS),META	$(MM_PHASE)	$(BUILD)	$(MXE_TARGETS))
define MM_CAPTURE_NODE
$(file >>$(MM_RECORDS),$(TARGET)	$(PKG)	$($(PKG)_TYPE)	$(if $(value $(call LOOKUP_PKG_RULE,$(PKG),BUILD,$(TARGET))),true,false)	$(strip $(PKG_DEPS))	$(strip $(PKG_OO_DEPS))	$(strip $(PKG_ALL_DEPS))	$(call LOOKUP_PKG_RULE,$(PKG),BUILD,$(TARGET))	$(if $(filter sources,$(MM_PHASE)),$($(PKG)_VERSION))	$(if $(filter sources,$(MM_PHASE)),$($(PKG)_CHECKSUM))	$(if $(filter sources,$(MM_PHASE)),$($(call LOOKUP_PKG_RULE,$(PKG),FILE,$(TARGET))))	$(if $(filter sources,$(MM_PHASE)),$($(PKG)_SUBDIR))	$(if $(filter sources,$(MM_PHASE)),$($(call LOOKUP_PKG_RULE,$(PKG),URL,$(TARGET))))	$(if $(filter sources,$(MM_PHASE)),$($(PKG)_URL_2))	$(if $(filter sources,$(MM_PHASE)),$($(PKG)_PATCHES)))
endef
$(foreach TARGET,$(MXE_TARGETS),$(foreach PKG,$($(TARGET)_PKGS),$(if $(or $(filter edges,$(MM_PHASE)),$(filter $(TARGET)~$(PKG),$(MM_FILTER))),$(call MM_CAPTURE_NODE))))
.PHONY: mediamanager-source-graph
mediamanager-source-graph:
	@:

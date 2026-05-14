namespace sl {
enum class Result { eOk, eError };
}

#define SL_FEATURE_DLSS 1
#define SL_FEATURE_DLSS_G 2
#define SL_FEATURE_DLSS_MFG 3
#define SL_FEATURE_REFLEX 4
int slInit();
int slShutdown();

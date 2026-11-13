import HealthKit

/// Asks to read workouts from Apple Health. Health never says whether a read was allowed, so the
/// answer also counts the workouts the app can read afterwards.
enum WorkoutAccess {
    private static let store = HKHealthStore()

    static func request() async -> [String: Any] {
        guard HKHealthStore.isHealthDataAvailable() else { return ["available": false] }
        do {
            try await store.requestAuthorization(toShare: [], read: [HKObjectType.workoutType()])
        } catch {
            return ["available": true, "error": error.localizedDescription]
        }
        guard let workouts = await readableWorkouts() else { return ["available": true] }
        return ["available": true, "workouts": workouts]
    }

    private static func readableWorkouts() async -> Int? {
        await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(), predicate: nil, limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                continuation.resume(returning: error == nil ? samples?.count ?? 0 : nil)
            }
            store.execute(query)
        }
    }
}
